const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function main() {
  const coachPasswordHash = await bcrypt.hash("coach123", 10);
  const coachUser = await prisma.user.create({
    data: { email: "coach@example.com", passwordHash: coachPasswordHash },
  });

  // Coach manages two teams, to exercise multi-team support.
  const teamA = await prisma.team.create({
    data: { name: "Riverside U12 Sharks", sport: "Soccer", season: "Fall 2026" },
  });
  const teamB = await prisma.team.create({
    data: { name: "Riverside U14 Hawks", sport: "Soccer", season: "Fall 2026" },
  });

  await prisma.membership.create({ data: { userId: coachUser.id, teamId: teamA.id, role: "coach" } });
  await prisma.membership.create({ data: { userId: coachUser.id, teamId: teamB.id, role: "coach" } });

  const player = await prisma.player.create({
    data: {
      teamId: teamA.id,
      firstName: "Jamie",
      lastName: "Rivera",
      email: "jamie@example.com",
      jerseyNumber: "7",
      position: "Midfielder",
      guardianName: "Alex Rivera",
      emergencyContact: "555-0100",
    },
  });

  const playerPasswordHash = await bcrypt.hash("player123", 10);
  const playerUser = await prisma.user.create({
    data: { email: "jamie@example.com", passwordHash: playerPasswordHash },
  });
  await prisma.membership.create({
    data: { userId: playerUser.id, teamId: teamA.id, role: "player", playerId: player.id },
  });

  const event = await prisma.event.create({
    data: {
      teamId: teamA.id,
      type: "game",
      title: "vs. Lakeside FC",
      location: "Riverside Park Field 3",
      startTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  await prisma.rSVP.create({ data: { eventId: event.id, playerId: player.id } });

  await prisma.message.create({
    data: { teamId: teamA.id, body: "Welcome to the season!", isAnnouncement: true },
  });

  console.log("Seeded teams:", teamA.id, teamB.id);
  console.log("Login as coach (2 teams): coach@example.com / coach123");
  console.log("Login as player (1 team): jamie@example.com / player123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
