/**
 * Railway infrastructure for mynaposter.
 *
 * Two services out of one repository: the marketing site and the API. They are
 * separate because they fail differently — the site is static and should stay
 * up regardless of what the API is doing, and only one of them should ever run
 * the scheduler.
 *
 * The site service is named "mynaposter.com" because Railway renames a service
 * to its custom domain when one is attached. Keep this in step with the real
 * name or `railway config plan` offers to create a duplicate.
 *
 * Postgres is deliberately absent. It runs in a container we control
 * (docker-compose.yml) and reaches the API through DATABASE_URL.
 */
import { defineRailway, github, preserve, project, service } from "railway/iac";

/**
 * Marks this file as describing only part of the project.
 *
 * Without it, Railway treats the file as the whole definition of the
 * "Profullstack, Inc." project and plans to destroy every service it does not
 * mention — 70 of them, including hqtui, ugig.net, qrypt.chat, moshcode and
 * three Postgres databases. `railway config plan` reported
 * "2 to add, 70 to destroy" before this line existed, and "0 to destroy" after.
 *
 * Two things about the value:
 *
 *   1. It must be a STRING. An array typechecks and is silently ignored by the
 *      CLI, which leaves every deletion in the plan.
 *   2. It is an ownership GROUP NAME recorded server-side, not a free-form
 *      label. Both services below belong to the group "mynaposter-web".
 *      Renaming it after an apply fails with "Cannot manage service
 *      mynaposter-api: already managed by partial mynaposter-web", which is why
 *      it keeps the original name even though the site service was renamed.
 *
 * Always read the destroy count in `railway config plan` before applying.
 */
export const partial = "mynaposter-web";

const REPO = "profullstack/mynaposter";

export default defineRailway(() => {
  const web = service("mynaposter.com", {
    source: github(REPO),
    // The site is generated from the network registry at deploy time, so the
    // published list cannot drift from the code that implements it.
    start: "bun apps/web/src/build.ts && bun apps/web/src/server.ts",
    domains: ["mynaposter.com", "www.mynaposter.com"],
  });

  const api = service("mynaposter-api", {
    source: github(REPO),
    start: "bun apps/api/src/server.ts",
    variables: {
      // preserve() declares the variable without putting its value in the repo.
      // Rotate it with `railway variable set --stdin MYNA_API_TOKEN`.
      MYNA_API_TOKEN: preserve(),
      // Only one instance may run the scheduler, or a queued post goes out
      // twice. The site service never runs it.
      MYNA_SCHEDULER: "0",
      MYNA_SCHEDULER_INTERVAL: "30",
    },
  });

  return project("Profullstack, Inc.", {
    resources: [web, api],
  });
});
