/**
 * Railway infrastructure for mynaposter.
 *
 * Two services out of one repository: the marketing site and the API. They are
 * separate because they fail differently — the site is static and should stay
 * up regardless of what the API is doing, and only one of them should ever run
 * the scheduler.
 *
 * Postgres is deliberately not here. It runs in a container we control
 * (docker-compose.yml) and reaches the API through DATABASE_URL.
 */
import { defineRailway, project, service } from "railway/iac";

/**
 * Marks this file as describing only part of the project.
 *
 * Without it, Railway treats the file as the whole definition of the
 * "Profullstack, Inc." project and plans to destroy every service it does not
 * mention - 70 of them, including hqtui, ugig.net, qrypt.chat, moshcode and
 * three Postgres databases. `railway config plan` reported
 * "2 to add, 70 to destroy" before this line existed, and "0 to destroy" after.
 *
 * The value must be a STRING. An array is accepted by TypeScript and silently
 * ignored by the CLI, which leaves every deletion in the plan. Both services
 * below are still created; the string is a marker, not a list.
 *
 * Do not remove this unless this repository genuinely owns the entire project.
 */
export const partial = "mynaposter-web";

export default defineRailway(() => {
  const web = service("mynaposter-web", {
    // Static marketing site. Built from the network registry at deploy time so
    // the published list cannot drift from the code.
    start: "bun apps/web/src/build.ts && bun apps/web/src/server.ts",
  });

  const api = service("mynaposter-api", {
    start: "bun apps/api/src/server.ts",
  });

  return project("Profullstack, Inc.", {
    resources: [web, api],
  });
});
