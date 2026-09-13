/**
 * @profullstack/openprofile: one reader and writer for OpenProfile.md
 * (logicsrc.com/openprofile), with the Broadcast and Guest sections
 * (logicsrc.com/openbroadcast, logicsrc.com/openguest), an owner overlay
 * every app applies the same way, identity keys for de-duplication, and a
 * merge of several documents about one person.
 */

export {
  parseOpenProfile,
  normaliseSection,
  identityMap,
  identityValue,
  kindOf,
  section,
  sections,
  bullets,
  sectionKeys,
  keyValue,
  accounts,
  topics,
  SECTION_ALIASES,
  KNOWN_SECTIONS,
} from "./parse.ts";
export type { OpenProfileDoc, IdentityEntry, Section, Account } from "./parse.ts";

export { renderOpenProfile, makeOpenProfile, keyLine, keyLines, keyedSection, listSection, orderSections } from "./render.ts";

export { normaliseUrl, normaliseEmail, identityKeys, samePerson, networkOf } from "./identity.ts";

export { applyOverrides, overridesFromDocument, mergeOverrides, mergeProfiles, broadcasts, guest, REMOVED } from "./merge.ts";
export type { Overrides } from "./merge.ts";

/** The media type a profile is served as. */
export const MEDIA_TYPE = "text/markdown; charset=utf-8";

/** The link relation a page uses to point at its profile. */
export const LINK_REL = "openprofile";

/** The well-known path a domain that is a person serves the file at. */
export const WELL_KNOWN_PATH = "/.well-known/openprofile.md";

/** The OpenAccess scope an app asks for to edit a profile on the person's behalf. */
export const EDIT_SCOPE = "openprofile:edit";
