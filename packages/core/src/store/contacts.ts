/**
 * People you may write to, and the lists they are on.
 *
 * A contact is whatever is known: an email, a phone, handles on networks, an
 * OpenProfile URL, and where it came from. Nothing here is secret, so it is
 * plain JSON like the queue. The lists are names over contact ids. An opt-out
 * is permanent and wins over every list.
 */
import { readJson, writeJson } from "../util/json.ts";
import { CONTACTS_FILE } from "../util/paths.ts";

export interface Contact {
  /** The email, else the phone, else the first handle, lowercased. */
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  /** `network:handle`. */
  handles: string[];
  openprofile: string | null;
  /** Where it came from: `manual`, `agenticjobs:<slug>`, ... */
  source: string;
  tags: string[];
  addedAt: string;
  optedOut?: boolean;
  note?: string;
}

export interface ContactsFile {
  contacts: Contact[];
  lists: Record<string, string[]>;
}

export function readContacts(): ContactsFile {
  const file = readJson<Partial<ContactsFile>>(CONTACTS_FILE, {});
  return { contacts: Array.isArray(file.contacts) ? file.contacts : [], lists: file.lists ?? {} };
}

export function writeContacts(file: ContactsFile): void {
  writeJson(CONTACTS_FILE, file);
}

export const contactId = (input: { email?: string | null; phone?: string | null; handles?: string[] }): string | null => {
  if (input.email) return input.email.trim().toLowerCase();
  if (input.phone) return input.phone.replace(/[^\d+]/g, "");
  if (input.handles?.length) return (input.handles[0] as string).trim().toLowerCase();
  return null;
};

/** Add or merge. A contact seen twice keeps what it had and gains what is new. */
export function upsertContact(input: Omit<Contact, "id" | "addedAt"> & { addedAt?: string }, file = readContacts()): Contact {
  const id = contactId(input);
  if (!id) throw new Error("A contact needs an email, a phone, or a handle.");
  const existing = file.contacts.find((contact) => contact.id === id);
  if (existing) {
    existing.name = existing.name ?? input.name;
    existing.email = existing.email ?? input.email;
    existing.phone = existing.phone ?? input.phone;
    existing.handles = [...new Set([...existing.handles, ...input.handles])];
    existing.openprofile = existing.openprofile ?? input.openprofile;
    existing.tags = [...new Set([...existing.tags, ...input.tags])];
    if (input.note && !existing.note) existing.note = input.note;
    writeContacts(file);
    return existing;
  }
  const contact: Contact = { id, addedAt: input.addedAt ?? new Date().toISOString(), ...input, handles: [...new Set(input.handles)], tags: [...new Set(input.tags.map((t) => t.toLowerCase()))] };
  file.contacts.push(contact);
  writeContacts(file);
  return contact;
}

export function removeContact(id: string, file = readContacts()): boolean {
  const before = file.contacts.length;
  file.contacts = file.contacts.filter((contact) => contact.id !== id);
  for (const list of Object.keys(file.lists)) file.lists[list] = (file.lists[list] ?? []).filter((member) => member !== id);
  writeContacts(file);
  return file.contacts.length < before;
}

export function optOut(id: string, file = readContacts()): boolean {
  const contact = file.contacts.find((entry) => entry.id === id);
  if (!contact) return false;
  contact.optedOut = true;
  writeContacts(file);
  return true;
}

export function addToList(list: string, ids: string[], file = readContacts()): number {
  const name = list.trim().toLowerCase();
  const known = new Set(file.contacts.map((contact) => contact.id));
  const members = new Set(file.lists[name] ?? []);
  let added = 0;
  for (const id of ids) {
    if (!known.has(id)) throw new Error(`No contact ${id}.`);
    if (!members.has(id)) {
      members.add(id);
      added++;
    }
  }
  file.lists[name] = [...members];
  writeContacts(file);
  return added;
}

/** Who a send goes to: a list by name, or a tag, never anyone opted out. */
export function recipients(selector: { list?: string; tag?: string; ids?: string[] }, file = readContacts()): Contact[] {
  const byId = new Map(file.contacts.map((contact) => [contact.id, contact]));
  let chosen: Contact[] = [];
  if (selector.list) chosen = (file.lists[selector.list.toLowerCase()] ?? []).map((id) => byId.get(id)).filter((c): c is Contact => Boolean(c));
  else if (selector.tag) chosen = file.contacts.filter((contact) => contact.tags.includes(selector.tag!.toLowerCase()));
  else if (selector.ids) chosen = selector.ids.map((id) => byId.get(id.toLowerCase()) ?? byId.get(id)).filter((c): c is Contact => Boolean(c));
  return chosen.filter((contact) => !contact.optedOut);
}
