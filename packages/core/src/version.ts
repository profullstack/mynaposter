/**
 * One version, read by everything.
 *
 * It used to be a literal in six files: the CLI, the API, both MCP transports
 * and two package.json files. A release that updated five of them would ship a
 * binary reporting the wrong version, and nothing would fail. A test asserts
 * this matches the package.json it is published under.
 */
export const VERSION = "0.2.0";
