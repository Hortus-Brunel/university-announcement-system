/**
 * cleanup.js
 * Deletes ALL data from the system and ALL user accounts
 * except the L5_SUPER_ADMIN account.
 *
 * Run with: node prisma/cleanup.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const SUPER_ADMIN_EMAIL = 'oassonkeng@gmail.com';

async function main() {
  console.log('🧹  Starting system cleanup...\n');

  // ── 1. Find the super admin so we can preserve them ─────────────────────────
  const superAdmin = await prisma.user.findUnique({
    where: { email: SUPER_ADMIN_EMAIL },
    select: { id: true, fullName: true, email: true },
  });

  if (!superAdmin) {
    console.error(`❌  Super admin (${SUPER_ADMIN_EMAIL}) not found. Aborting.`);
    process.exit(1);
  }
  console.log(`✅  Super admin found: ${superAdmin.fullName} <${superAdmin.email}>`);
  console.log(`    (ID: ${superAdmin.id})\n`);

  // ── 2. Delete all announcement-related data ──────────────────────────────────
  const reactions    = await prisma.reaction.deleteMany({});
  const comments     = await prisma.comment.deleteMany({});
  const bookmarks    = await prisma.bookmark.deleteMany({});
  const notifs       = await prisma.notification.deleteMany({});
  const attachments  = await prisma.attachment.deleteMany({});
  const targets      = await prisma.announcementTarget.deleteMany({});
  const announcements = await prisma.announcement.deleteMany({});
  console.log(`🗑️   Announcements & related data cleared:`);
  console.log(`     • Announcements : ${announcements.count}`);
  console.log(`     • Targets       : ${targets.count}`);
  console.log(`     • Attachments   : ${attachments.count}`);
  console.log(`     • Bookmarks     : ${bookmarks.count}`);
  console.log(`     • Notifications : ${notifs.count}`);
  console.log(`     • Reactions     : ${reactions.count}`);
  console.log(`     • Comments      : ${comments.count}\n`);

  // ── 3. Delete all sessions & refresh tokens (all users) ─────────────────────
  const sessions = await prisma.userSession.deleteMany({});
  const tokens   = await prisma.refreshToken.deleteMany({});
  console.log(`🔑   Sessions & tokens cleared:`);
  console.log(`     • Sessions       : ${sessions.count}`);
  console.log(`     • Refresh tokens : ${tokens.count}\n`);

  // ── 4. Clear audit & activity logs ──────────────────────────────────────────
  const auditLogs    = await prisma.auditLog.deleteMany({});
  const activityLogs = await prisma.activityLog.deleteMany({});
  console.log(`📋   Logs cleared:`);
  console.log(`     • Audit logs    : ${auditLogs.count}`);
  console.log(`     • Activity logs : ${activityLogs.count}\n`);

  // ── 5. Remove memberships for all non-admin users ───────────────────────────
  const deptMemberships  = await prisma.userDepartmentMembership.deleteMany({
    where: { userId: { not: superAdmin.id } },
  });
  const classMemberships = await prisma.userClassMembership.deleteMany({
    where: { userId: { not: superAdmin.id } },
  });
  const clubMemberships  = await prisma.userClubMembership.deleteMany({
    where: { userId: { not: superAdmin.id } },
  });
  const courseMemberships = await prisma.userCourseMembership.deleteMany({
    where: { userId: { not: superAdmin.id } },
  });
  console.log(`👥   Memberships cleared (non-admin users):`);
  console.log(`     • Dept memberships   : ${deptMemberships.count}`);
  console.log(`     • Class memberships  : ${classMemberships.count}`);
  console.log(`     • Club memberships   : ${clubMemberships.count}`);
  console.log(`     • Course memberships : ${courseMemberships.count}\n`);

  // ── 6. Delete all user accounts EXCEPT the super admin ──────────────────────
  const deletedUsers = await prisma.user.deleteMany({
    where: { id: { not: superAdmin.id } },
  });
  console.log(`🧑‍💼   Users deleted: ${deletedUsers.count}`);
  console.log(`     ✅  Super admin preserved.\n`);

  console.log('✅  Cleanup complete! The system is now empty except for the super admin account.');
  console.log(`\n    Login: ${superAdmin.email}`);
  console.log('    Password: Admin123! (unchanged)\n');
}

main()
  .catch((e) => {
    console.error('❌  Cleanup failed:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
