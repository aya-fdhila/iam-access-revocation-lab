import { forbidden, notFound } from "./errors.js";
import type { Principal } from "./principal.js";

export type DocumentRecord = {
  id: number;
  owner: string;
  title: string;
};

const acceptedDocumentRoles = ["employees", "managers", "admins"];

export function requireScope(principal: Principal, scope: string): void {
  if (!principal.scopes.has(scope)) {
    throw forbidden("missing_scope", `The ${scope} scope is required.`);
  }
}

export function requireDocumentRole(principal: Principal): void {
  if (!acceptedDocumentRoles.some((role) => principal.roles.has(role))) {
    throw forbidden("missing_role", "An employee, manager, or administrator role is required.");
  }
}

export function canReadAllDocuments(principal: Principal): boolean {
  return principal.roles.has("managers") || principal.roles.has("admins");
}

export function requireReadableDocument(principal: Principal, document: DocumentRecord): void {
  if (canReadAllDocuments(principal) || principal.username === document.owner) return;
  throw forbidden("ownership_denied", "The requested document is not accessible to this identity.");
}

export function requireDeletableDocument(principal: Principal, document: DocumentRecord): void {
  if (principal.roles.has("admins") || principal.username === document.owner) return;
  throw forbidden("ownership_denied", "The requested document cannot be deleted by this identity.");
}

export function requireAdmin(principal: Principal): void {
  requireScope(principal, "admin");
  if (!principal.roles.has("admins")) {
    throw forbidden("missing_role", "The administrator role is required.");
  }
}

export function requireJob(principal: Principal): void {
  requireScope(principal, "reports:run");
  if (principal.clientId !== "job" || principal.username !== "service-account-job") {
    throw forbidden("wrong_service_identity", "The scheduled-job service identity is required.");
  }
}

export class DocumentRepository {
  readonly #documents = new Map<number, DocumentRecord>([
    [1, { id: 1, owner: "aya", title: "Administrator continuity plan" }],
    [2, { id: 2, owner: "ali", title: "Employee access guide" }],
    [3, { id: 3, owner: "marwa", title: "Offboarding evidence worksheet" }],
  ]);
  #nextId = 4;

  list(): DocumentRecord[] {
    return [...this.#documents.values()];
  }

  get(id: number): DocumentRecord {
    const document = this.#documents.get(id);
    if (document === undefined) throw notFound("Document not found.");
    return document;
  }

  create(owner: string, title: string): DocumentRecord {
    const document = { id: this.#nextId, owner, title };
    this.#nextId += 1;
    this.#documents.set(document.id, document);
    return document;
  }

  delete(id: number): void {
    this.#documents.delete(id);
  }
}
