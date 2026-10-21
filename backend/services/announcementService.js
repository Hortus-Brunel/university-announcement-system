const prisma = require('../config/db');
const { logAudit } = require('../middlewares/audit');
const logger = require('../config/logger');
const { LEVEL_ORDER } = require('../middlewares/auth');

// ─────────────────────────────────────────────────────────────────────────────
// Audience Segmentation Engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the WHERE clause to find announcements visible to a given user.
 * A user sees an announcement if ANY of its targets match ANY of their memberships.
 *
 * @param {object} user - req.user (contains faculty/dept/level/programme IDs)
 * @param {object[]} classMemberships - user's class memberships
 * @param {object[]} clubMemberships  - user's club memberships
 * @returns {object} Prisma 'some' filter for announcement_targets
 */
async function buildAudienceFilter(user) {
  // Fetch dynamic memberships
  const classMemberships = await prisma.userClassMembership.findMany({
    where: { userId: user.id },
    select: { classId: true },
  });

  const clubMemberships = await prisma.userClubMembership.findMany({
    where: { userId: user.id },
    select: { clubId: true },
  });

  const courseMemberships = await prisma.userCourseMembership.findMany({
    where: { userId: user.id },
    select: { courseId: true },
  });

  // Build array of OR conditions for targets.
  // For each scope the user belongs to, we match:
  //   (a) an announcement targeted specifically to that scopeId
  //   (b) an announcement targeted with scopeId=null (meaning "all in that scope")
  const targetConditions = [
    { scope: 'UNIVERSITY', scopeId: null }, // University-wide (always applies)
  ];

  if (user.primaryFacultyId) {
    targetConditions.push({ scope: 'FACULTY', scopeId: user.primaryFacultyId });
    targetConditions.push({ scope: 'FACULTY', scopeId: null }); // general faculty-wide
  }
  if (user.primaryDepartmentId) {
    targetConditions.push({ scope: 'DEPARTMENT', scopeId: user.primaryDepartmentId });
    targetConditions.push({ scope: 'DEPARTMENT', scopeId: null }); // general dept-wide
  }
  if (user.levelId) {
    targetConditions.push({ scope: 'LEVEL', scopeId: user.levelId });
    targetConditions.push({ scope: 'LEVEL', scopeId: null });
  }
  if (user.programmeId) {
    targetConditions.push({ scope: 'PROGRAMME', scopeId: user.programmeId });
    targetConditions.push({ scope: 'PROGRAMME', scopeId: null });
  }
  for (const { classId } of classMemberships) {
    targetConditions.push({ scope: 'CLASS', scopeId: classId });
    targetConditions.push({ scope: 'CLASS', scopeId: null });
  }
  for (const { clubId } of clubMemberships) {
    targetConditions.push({ scope: 'CLUB', scopeId: clubId });
    targetConditions.push({ scope: 'CLUB', scopeId: null });
  }

  // Individual targeted announcements
  targetConditions.push({ scope: 'INDIVIDUAL', scopeId: user.id });

  return { some: { OR: targetConditions } };
}

/**
 * Validate that an author has scope permission to target the given audiences.
 * L1 reps can only target their own class or club.
 * L2+ can target department, faculty, or university depending on level.
 */
async function validateTargetScopes(targets, author) {
  const level = LEVEL_ORDER[author.accessLevel] ?? -1;

  for (const { scope, scopeId } of targets) {
    if (scope === 'UNIVERSITY' && level < LEVEL_ORDER['L4_UNIVERSITY_ADMIN']) {
      throw Object.assign(new Error('Only University Administrators can target the entire university.'), { statusCode: 403 });
    }

    if (scope === 'FACULTY' && level < LEVEL_ORDER['L3_FACULTY_ADMIN']) {
      throw Object.assign(new Error('Only Faculty Administrators can target a faculty.'), { statusCode: 403 });
    }

    if (scope === 'DEPARTMENT' && level < LEVEL_ORDER['L2_DEPT_ADMIN']) {
      throw Object.assign(new Error('Only Department Administrators can target a department.'), { statusCode: 403 });
    }

    if (scope === 'CLASS' && level < LEVEL_ORDER['L1_REP']) {
      throw Object.assign(new Error('Only Class Representatives can target classes.'), { statusCode: 403 });
    }

    if (scope === 'CLUB' && level < LEVEL_ORDER['L1_REP']) {
      throw Object.assign(new Error('Only Club Leaders can target clubs.'), { statusCode: 403 });
    }

    // For L1: verify ownership of the class/club they're targeting
    if (scope === 'CLASS' && level === LEVEL_ORDER['L1_REP'] && scopeId) {
      const membership = await prisma.userClassMembership.findFirst({
        where: { userId: author.id, classId: scopeId, isRep: true },
      });
      if (!membership) {
        throw Object.assign(new Error('You can only post announcements to classes where you are a representative.'), { statusCode: 403 });
      }
    }

    if (scope === 'CLUB' && level === LEVEL_ORDER['L1_REP'] && scopeId) {
      const membership = await prisma.userClubMembership.findFirst({
        where: { userId: author.id, clubId: scopeId, isLeader: true },
      });
      if (!membership) {
        throw Object.assign(new Error('You can only post announcements to clubs where you are a leader.'), { statusCode: 403 });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Announcement CRUD & Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

const ANNOUNCEMENT_INCLUDE = {
  author: { select: { id: true, fullName: true, email: true, avatarUrl: true, accessLevel: true } },
  category: { select: { id: true, name: true, colorHex: true } },
  targets: { select: { id: true, scope: true, scopeId: true } },
  attachments: true,
  _count: { select: { bookmarks: true } },
};

/**
 * Reusable Prisma filter: exclude announcements whose expiresAt has passed.
 * An announcement with expiresAt = null never expires.
 */
const NOT_EXPIRED = {
  OR: [
    { expiresAt: null },
    { expiresAt: { gt: new Date() } },
  ],
};

/**
 * Create a new announcement.
 * L1 reps (class/club) publish immediately without approval.
 * L2+ also publish immediately — authorized publishers do not need approval.
 */
async function createAnnouncement({ title, content, categoryId, isPinned, isImportant, publishAt, expiresAt, targets, attachments }, author) {
  // Validate audience targets
  await validateTargetScopes(targets, author);

  // All authorized publishers (L1+) publish immediately — no approval step needed
  const initialStatus = 'published';

  const announcement = await prisma.announcement.create({
    data: {
      title,
      content,
      authorId: author.id,
      categoryId: categoryId || null,
      status: initialStatus,
      isPinned: isPinned || false,
      isImportant: isImportant || false,
      publishAt: publishAt ? new Date(publishAt) : null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      targets: {
        create: targets.map(({ scope, scopeId }) => ({
          scope,
          scopeId: scopeId || null,
        })),
      },
      ...(attachments && attachments.length > 0 && {
        attachments: {
          create: attachments.map(({ fileName, fileUrl, fileType, fileSizeBytes }) => ({
            fileName,
            fileUrl,
            fileType,
            fileSizeBytes: fileSizeBytes || null,
          })),
        },
      }),
    },
    include: ANNOUNCEMENT_INCLUDE,
  });

  await logAudit({
    actorId: author.id,
    action: 'ANNOUNCEMENT_CREATED',
    targetTable: 'announcements',
    targetId: announcement.id,
    metadata: { title, status: announcement.status },
  });

  // Dispatch notifications if published immediately (L2+ drafts pushed by admin)
  if (announcement.status === 'published') {
    await dispatchNotifications(announcement, author);
  }

  return announcement;
}

/**
 * Get announcements visible to the requesting user (audience segmentation).
 */
async function getMyAnnouncements(user, { page = 1, limit = 20, search, categoryId, status } = {}) {
  const skip = (page - 1) * limit;
  const audienceFilter = await buildAudienceFilter(user);

  const where = {
    targets: audienceFilter,
    status: status || 'published', // Default: only published
    ...NOT_EXPIRED,               // ← Never return expired records to client
    ...(categoryId && { categoryId }),
    ...(search && {
      OR: [
        { title: { contains: search, mode: 'insensitive' } },
        { content: { contains: search, mode: 'insensitive' } },
      ],
    }),
  };

  const [announcements, total] = await Promise.all([
    prisma.announcement.findMany({
      where,
      skip,
      take: limit,
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
      include: ANNOUNCEMENT_INCLUDE,
    }),
    prisma.announcement.count({ where }),
  ]);

  return { announcements, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } };
}

/**
 * Get all announcements (admin: filter by status, author, etc.).
 */
async function listAllAnnouncements({ page = 1, limit = 20, search, categoryId, status, authorId, scope, includeExpired = false } = {}) {
  const skip = (page - 1) * limit;

  const where = {
    // Admins can pass includeExpired=true to see expired posts in the dashboard;
    // by default expired posts are excluded even from admin views.
    ...(!includeExpired && NOT_EXPIRED),
    ...(status && { status }),
    ...(categoryId && { categoryId }),
    ...(authorId && { authorId }),
    ...(scope && { targets: { some: { scope } } }),
    ...(search && {
      OR: [
        { title: { contains: search, mode: 'insensitive' } },
        { content: { contains: search, mode: 'insensitive' } },
      ],
    }),
  };

  const [announcements, total] = await Promise.all([
    prisma.announcement.findMany({
      where,
      skip,
      take: limit,
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
      include: ANNOUNCEMENT_INCLUDE,
    }),
    prisma.announcement.count({ where }),
  ]);

  return { announcements, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } };
}

/**
 * Get a single announcement by ID. Verifies the user has visibility.
 */
async function getAnnouncementById(announcementId, user) {
  const announcement = await prisma.announcement.findUnique({
    where: { id: announcementId },
    include: { ...ANNOUNCEMENT_INCLUDE, moderator: { select: { id: true, fullName: true } } },
  });

  if (!announcement) throw Object.assign(new Error('Announcement not found.'), { statusCode: 404 });

  // Block access to expired announcements for non-admins
  const userLevel = LEVEL_ORDER[user.accessLevel] ?? 0;
  const isAdmin = userLevel >= LEVEL_ORDER['L2_DEPT_ADMIN'];
  const isExpired = announcement.expiresAt && announcement.expiresAt <= new Date();

  if (isExpired && !isAdmin) {
    throw Object.assign(new Error('Announcement not found.'), { statusCode: 404 });
  }

  // Non-admins can only see published announcements
  if (!isAdmin && announcement.status !== 'published') {
    // Only the author can see their own non-published announcements
    if (announcement.authorId !== user.id) {
      throw Object.assign(new Error('Announcement not found.'), { statusCode: 404 });
    }
  }

  return announcement;
}

/**
 * Update an announcement (only by author if draft, or admin).
 */
async function updateAnnouncement(announcementId, updateData, user) {
  const existing = await prisma.announcement.findUnique({ where: { id: announcementId } });
  if (!existing) throw Object.assign(new Error('Announcement not found.'), { statusCode: 404 });

  const isAuthor = existing.authorId === user.id;
  const userLevel = LEVEL_ORDER[user.accessLevel] ?? 0;
  const isAdmin = userLevel >= LEVEL_ORDER['L2_DEPT_ADMIN'];

  if (!isAuthor && !isAdmin) {
    throw Object.assign(new Error('You do not have permission to edit this announcement.'), { statusCode: 403 });
  }

  if (isAuthor && !isAdmin && !['draft', 'rejected'].includes(existing.status)) {
    throw Object.assign(new Error('You can only edit announcements that are in draft or rejected status.'), { statusCode: 403 });
  }

  const { title, content, categoryId, isPinned, isImportant, publishAt, expiresAt, targets, attachments } = updateData;

  const updated = await prisma.announcement.update({
    where: { id: announcementId },
    data: {
      ...(title && { title }),
      ...(content && { content }),
      ...(categoryId !== undefined && { categoryId }),
      ...(isPinned !== undefined && { isPinned }),
      ...(isImportant !== undefined && { isImportant }),
      ...(publishAt !== undefined && { publishAt: publishAt ? new Date(publishAt) : null }),
      ...(expiresAt !== undefined && { expiresAt: expiresAt ? new Date(expiresAt) : null }),
      ...(targets && {
        targets: {
          deleteMany: {},
          create: targets.map(({ scope, scopeId }) => ({ scope, scopeId: scopeId || null })),
        },
      }),
      ...(attachments && {
        attachments: {
          deleteMany: {},
          create: attachments.map(({ fileName, fileUrl, fileType, fileSizeBytes }) => ({
            fileName,
            fileUrl,
            fileType,
            fileSizeBytes: fileSizeBytes || null,
          })),
        },
      }),
    },
    include: ANNOUNCEMENT_INCLUDE,
  });

  await logAudit({ actorId: user.id, action: 'ANNOUNCEMENT_UPDATED', targetTable: 'announcements', targetId: announcementId });
  return updated;
}

/**
 * Change the lifecycle status of an announcement.
 * Enforces who can transition to what status.
 */
const ALLOWED_TRANSITIONS = {
  L1_REP:               ['draft'],
  L2_DEPT_ADMIN:        ['draft', 'pending_approval', 'approved', 'published', 'archived', 'rejected'],
  L3_FACULTY_ADMIN:     ['draft', 'pending_approval', 'approved', 'published', 'archived', 'rejected'],
  L4_UNIVERSITY_ADMIN:  ['draft', 'pending_approval', 'approved', 'published', 'archived', 'rejected'],
  L5_SUPER_ADMIN:       ['draft', 'pending_approval', 'approved', 'scheduled', 'published', 'archived', 'rejected'],
};

async function changeAnnouncementStatus(announcementId, newStatus, rejectionReason, user) {
  const existing = await prisma.announcement.findUnique({ where: { id: announcementId }, include: { author: true } });
  if (!existing) throw Object.assign(new Error('Announcement not found.'), { statusCode: 404 });

  const allowed = ALLOWED_TRANSITIONS[user.accessLevel] || [];
  if (!allowed.includes(newStatus)) {
    throw Object.assign(new Error(`Your role cannot set status to '${newStatus}'.`), { statusCode: 403 });
  }

  const updateData = {
    status: newStatus,
    ...(newStatus === 'approved' && { approvedBy: user.id, approvedAt: new Date() }),
    ...(newStatus === 'rejected' && { rejectionReason: rejectionReason || null }),
  };

  const updated = await prisma.announcement.update({
    where: { id: announcementId },
    data: updateData,
    include: ANNOUNCEMENT_INCLUDE,
  });

  await logAudit({
    actorId: user.id,
    action: `ANNOUNCEMENT_STATUS_${newStatus.toUpperCase()}`,
    targetTable: 'announcements',
    targetId: announcementId,
    metadata: { from: existing.status, to: newStatus },
  });

  // Dispatch notifications when publishing
  if (newStatus === 'published') {
    await dispatchNotifications(updated, user);
  }

  return updated;
}

/**
 * Delete an announcement (author if draft/rejected, or L3+).
 */
async function deleteAnnouncement(announcementId, user) {
  const existing = await prisma.announcement.findUnique({ where: { id: announcementId } });
  if (!existing) throw Object.assign(new Error('Announcement not found.'), { statusCode: 404 });

  const isAuthor = existing.authorId === user.id;
  const userLevel = LEVEL_ORDER[user.accessLevel] ?? 0;
  const isAdmin = userLevel >= LEVEL_ORDER['L3_FACULTY_ADMIN'];

  if (!isAuthor && !isAdmin) {
    throw Object.assign(new Error('You do not have permission to delete this announcement.'), { statusCode: 403 });
  }

  if (isAuthor && !isAdmin && !['draft', 'rejected'].includes(existing.status)) {
    throw Object.assign(new Error('You can only delete your own draft or rejected announcements.'), { statusCode: 403 });
  }

  await prisma.announcement.delete({ where: { id: announcementId } });
  await logAudit({ actorId: user.id, action: 'ANNOUNCEMENT_DELETED', targetTable: 'announcements', targetId: announcementId });
}

// ─────────────────────────────────────────────────────────────────────────────
// Notification Dispatching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find all users matching the announcement targets and create notification records.
 * This is a best-effort operation; errors are logged but do not fail the request.
 */
async function dispatchNotifications(announcement, actor) {
  try {
    const targets = announcement.targets || [];
    const userConditions = [];

    for (const { scope, scopeId } of targets) {
      switch (scope) {
        case 'UNIVERSITY':
          userConditions.push({}); // All users — handled by bulk insert
          break;
        case 'FACULTY':
          // scopeId=null means "all users in ANY faculty" (general faculty-wide)
          if (scopeId) userConditions.push({ primaryFacultyId: scopeId });
          else userConditions.push({ primaryFacultyId: { not: null } });
          break;
        case 'DEPARTMENT':
          if (scopeId) userConditions.push({ primaryDepartmentId: scopeId });
          else userConditions.push({ primaryDepartmentId: { not: null } });
          break;
        case 'LEVEL':
          if (scopeId) userConditions.push({ levelId: scopeId });
          else userConditions.push({ levelId: { not: null } });
          break;
        case 'PROGRAMME':
          if (scopeId) userConditions.push({ programmeId: scopeId });
          else userConditions.push({ programmeId: { not: null } });
          break;
        case 'CLASS':
          if (scopeId) {
            const members = await prisma.userClassMembership.findMany({ where: { classId: scopeId }, select: { userId: true } });
            for (const { userId } of members) userConditions.push({ id: userId });
          }
          break;
        case 'CLUB':
          if (scopeId) {
            const members = await prisma.userClubMembership.findMany({ where: { clubId: scopeId }, select: { userId: true } });
            for (const { userId } of members) userConditions.push({ id: userId });
          }
          break;
        case 'INDIVIDUAL':
          if (scopeId) userConditions.push({ id: scopeId });
          break;
      }
    }

    const hasUniversity = targets.some((t) => t.scope === 'UNIVERSITY');
    const users = hasUniversity
      ? await prisma.user.findMany({ select: { id: true } })
      : userConditions.length > 0
        ? await prisma.user.findMany({ where: { OR: userConditions }, select: { id: true } })
        : [];

    const notifications = users.map((u) => ({
      userId: u.id,
      announcementId: announcement.id,
      message: `📢 New announcement: "${announcement.title}"`,
      isRead: false,
    }));

    if (notifications.length > 0) {
      await prisma.notification.createMany({ data: notifications, skipDuplicates: true });
    }

    logger.info('Notifications dispatched for announcement %s to %d users', announcement.id, notifications.length);
  } catch (err) {
    logger.error('Notification dispatch failed: %s', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bookmarks
// ─────────────────────────────────────────────────────────────────────────────

async function bookmarkAnnouncement(userId, announcementId) {
  const announcement = await prisma.announcement.findUnique({ where: { id: announcementId } });
  if (!announcement) throw Object.assign(new Error('Announcement not found.'), { statusCode: 404 });

  await prisma.bookmark.upsert({
    where: { userId_announcementId: { userId, announcementId } },
    update: {},
    create: { userId, announcementId },
  });

  return { bookmarked: true };
}

async function removeBookmark(userId, announcementId) {
  await prisma.bookmark.delete({
    where: { userId_announcementId: { userId, announcementId } },
  }).catch(() => {
    throw Object.assign(new Error('Bookmark not found.'), { statusCode: 404 });
  });
  return { bookmarked: false };
}

async function getMyBookmarks(userId, { page = 1, limit = 20 } = {}) {
  const skip = (page - 1) * limit;
  const [bookmarks, total] = await Promise.all([
    prisma.bookmark.findMany({
      where: { userId },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { announcement: { include: ANNOUNCEMENT_INCLUDE } },
    }),
    prisma.bookmark.count({ where: { userId } }),
  ]);

  return { bookmarks: bookmarks.map((b) => b.announcement), pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────────────────────

async function getMyNotifications(userId, { page = 1, limit = 20, unreadOnly = false } = {}) {
  const skip = (page - 1) * limit;
  const where = { userId, ...(unreadOnly && { isRead: false }) };

  const [notifications, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { announcement: { select: { id: true, title: true } } },
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, isRead: false } }),
  ]);

  return { notifications, unreadCount, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } };
}

async function markNotificationsRead(userId, notificationIds) {
  if (notificationIds && notificationIds.length > 0) {
    await prisma.notification.updateMany({
      where: { id: { in: notificationIds }, userId },
      data: { isRead: true },
    });
  } else {
    // Mark all as read if no IDs provided
    await prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reactions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Toggle a reaction (LIKE, DISLIKE, RESHARE) on an announcement.
 * If the reaction already exists it is removed (toggle off).
 * Notifies the announcement author.
 */
async function toggleReaction(announcementId, userId, type) {
  const validTypes = ['LIKE', 'DISLIKE', 'RESHARE'];
  if (!validTypes.includes(type)) {
    throw Object.assign(new Error(`Invalid reaction type. Must be one of: ${validTypes.join(', ')}`), { statusCode: 400 });
  }

  const announcement = await prisma.announcement.findUnique({
    where: { id: announcementId },
    select: { id: true, title: true, authorId: true },
  });
  if (!announcement) throw Object.assign(new Error('Announcement not found.'), { statusCode: 404 });

  const existing = await prisma.reaction.findUnique({
    where: { announcementId_userId_type: { announcementId, userId, type } },
  });

  let added;
  if (existing) {
    await prisma.reaction.delete({ where: { announcementId_userId_type: { announcementId, userId, type } } });
    added = false;
  } else {
    await prisma.reaction.create({ data: { announcementId, userId, type } });
    added = true;
    // Notify author (not if author reacts on own post)
    if (announcement.authorId !== userId) {
      const actor = await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
      await prisma.notification.create({
        data: {
          userId: announcement.authorId,
          announcementId,
          message: `${actor?.fullName || 'Someone'} reacted ${type} to your announcement "${announcement.title}"`,
        },
      });
    }
  }

  const counts = await prisma.reaction.groupBy({
    by: ['type'],
    where: { announcementId },
    _count: { type: true },
  });

  return { added, type, counts };
}

async function getReactions(announcementId, userId) {
  const counts = await prisma.reaction.groupBy({
    by: ['type'],
    where: { announcementId },
    _count: { type: true },
  });
  const userReactions = await prisma.reaction.findMany({
    where: { announcementId, userId },
    select: { type: true },
  });
  return { counts, userReactions: userReactions.map((r) => r.type) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Comments
// ─────────────────────────────────────────────────────────────────────────────

async function createComment(announcementId, userId, content) {
  if (!content || !content.trim()) {
    throw Object.assign(new Error('Comment content cannot be empty.'), { statusCode: 400 });
  }

  const announcement = await prisma.announcement.findUnique({
    where: { id: announcementId },
    select: { id: true, title: true, authorId: true },
  });
  if (!announcement) throw Object.assign(new Error('Announcement not found.'), { statusCode: 404 });

  const comment = await prisma.comment.create({
    data: { announcementId, userId, content: content.trim() },
    include: { user: { select: { id: true, fullName: true, avatarUrl: true, accessLevel: true } } },
  });

  // Notify author (unless commenting on own post)
  if (announcement.authorId !== userId) {
    const actor = await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
    await prisma.notification.create({
      data: {
        userId: announcement.authorId,
        announcementId,
        message: `${actor?.fullName || 'Someone'} commented on your announcement "${announcement.title}"`,
      },
    }).catch(() => {});
  }

  return comment;
}

async function getComments(announcementId, { page = 1, limit = 20 } = {}) {
  const skip = (page - 1) * limit;
  const [comments, total] = await Promise.all([
    prisma.comment.findMany({
      where: { announcementId },
      skip,
      take: limit,
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, fullName: true, avatarUrl: true, accessLevel: true } } },
    }),
    prisma.comment.count({ where: { announcementId } }),
  ]);
  return { comments, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } };
}

async function deleteComment(commentId, userId, userLevel) {
  const comment = await prisma.comment.findUnique({ where: { id: commentId } });
  if (!comment) throw Object.assign(new Error('Comment not found.'), { statusCode: 404 });
  const isOwner = comment.userId === userId;
  const isAdmin = userLevel >= LEVEL_ORDER['L2_DEPT_ADMIN'];
  if (!isOwner && !isAdmin) throw Object.assign(new Error('Cannot delete this comment.'), { statusCode: 403 });
  await prisma.comment.delete({ where: { id: commentId } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Expiry Purge Job
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hard-delete all announcements whose expiresAt has passed.
 * Cascade deletes handle targets, attachments, bookmarks, notifications,
 * reactions and comments automatically (defined in Prisma schema).
 *
 * Called by the scheduler in server.js — runs daily at midnight.
 * Returns the number of records permanently removed.
 */
async function purgeExpiredAnnouncements() {
  const now = new Date();

  // Collect IDs first so we can log them
  const expired = await prisma.announcement.findMany({
    where: { expiresAt: { lte: now } },
    select: { id: true, title: true, expiresAt: true },
  });

  if (expired.length === 0) {
    logger.info('[Purge] No expired announcements to remove.');
    return 0;
  }

  const expiredIds = expired.map((a) => a.id);

  // Delete in dependency order to respect FK constraints
  // (Prisma cascade handles most, but explicit ordering is safer)
  await prisma.reaction.deleteMany({ where: { announcementId: { in: expiredIds } } });
  await prisma.comment.deleteMany({ where: { announcementId: { in: expiredIds } } });
  await prisma.bookmark.deleteMany({ where: { announcementId: { in: expiredIds } } });
  await prisma.notification.deleteMany({ where: { announcementId: { in: expiredIds } } });
  await prisma.attachment.deleteMany({ where: { announcementId: { in: expiredIds } } });
  await prisma.announcementTarget.deleteMany({ where: { announcementId: { in: expiredIds } } });
  const { count } = await prisma.announcement.deleteMany({ where: { id: { in: expiredIds } } });

  logger.info(`[Purge] Permanently deleted ${count} expired announcement(s) from the database.`);
  for (const a of expired) {
    logger.info(`[Purge]   - "${a.title}" (expired: ${a.expiresAt.toISOString()})`);
  }

  return count;
}

module.exports = {
  createAnnouncement,
  getMyAnnouncements,
  listAllAnnouncements,
  getAnnouncementById,
  updateAnnouncement,
  changeAnnouncementStatus,
  deleteAnnouncement,
  bookmarkAnnouncement,
  removeBookmark,
  getMyBookmarks,
  getMyNotifications,
  markNotificationsRead,
  toggleReaction,
  getReactions,
  createComment,
  getComments,
  deleteComment,
  purgeExpiredAnnouncements,
};
