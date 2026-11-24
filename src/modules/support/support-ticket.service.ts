// src/modules/support/support-ticket.service.ts
// Support tickets for users and agents (#1327).
//
// Users only ever reach their own tickets: every user-facing query is filtered
// by userId, and a foreign ticket is reported as not found. Agents see all
// tickets through the admin routes.

import { createHash } from 'crypto';
import { envConfig } from '../../config';
import { SendMail } from '../../utils/mail.utils';
import { PaginationMetadata } from '../../utils/api-response.utils';
import { prisma } from '../../utils/prisma.utils';
import { signLink, verifyLink } from '../../utils/signed-url.utils';
import {
   AttachmentDeclaration,
   assertAttachmentDeclarations,
   verifyUploadedBytes,
} from './attachment-policy.utils';
import {
   ATTACHMENT_UPLOAD_PURPOSE,
   ATTACHMENT_UPLOAD_TTL_MS,
   MAX_ATTACHMENT_BYTES,
   SupportCategory,
   TICKET_STATUS_TRANSITIONS,
   TicketStatus,
} from './support.constants';

export class TicketNotFoundError extends Error {
   constructor() {
      super('Support ticket not found');
      this.name = 'TicketNotFoundError';
   }
}

export class TicketClosedError extends Error {
   constructor() {
      super('This ticket is closed and no longer accepts messages');
      this.name = 'TicketClosedError';
   }
}

export class InvalidStatusTransitionError extends Error {
   constructor(from: string, to: string) {
      super(`A ticket cannot move from ${from} to ${to}`);
      this.name = 'InvalidStatusTransitionError';
   }
}

export class AttachmentNotFoundError extends Error {
   constructor() {
      super('Attachment not found');
      this.name = 'AttachmentNotFoundError';
   }
}

export class AttachmentUploadError extends Error {
   constructor(
      message: string,
      public readonly statusCode: 403 | 404 | 409
   ) {
      super(message);
      this.name = 'AttachmentUploadError';
   }
}

export interface TicketAttachmentView {
   id: string;
   fileName: string;
   contentType: string;
   sizeBytes: number;
   status: string;
   uploadedAt: string | null;
}

export interface TicketMessageView {
   id: string;
   authorType: string;
   body: string;
   createdAt: string;
}

export interface TicketStatusChangeView {
   fromStatus: string | null;
   toStatus: string;
   actorType: string;
   createdAt: string;
}

export interface TicketView {
   id: string;
   category: string;
   subject: string;
   description: string;
   status: string;
   assigneeId: string | null;
   lastMessageAt: string;
   resolvedAt: string | null;
   closedAt: string | null;
   createdAt: string;
   updatedAt: string;
}

export interface TicketDetailView extends TicketView {
   userId?: string;
   messages: TicketMessageView[];
   attachments: TicketAttachmentView[];
   statusHistory: TicketStatusChangeView[];
}

export interface UploadSlot {
   attachmentId: string;
   fileName: string;
   uploadUrl: string;
   expiresAt: string;
   maxBytes: number;
}

export interface CreateTicketInput {
   category: SupportCategory;
   subject: string;
   description: string;
   attachments: AttachmentDeclaration[];
}

const iso = (value: Date): string => value.toISOString();
const isoOrNull = (value: Date | null): string | null => (value ? value.toISOString() : null);

const ATTACHMENT_SELECT = {
   id: true,
   fileName: true,
   contentType: true,
   sizeBytes: true,
   status: true,
   uploadedAt: true,
} as const;

function toTicketView(row: {
   id: string;
   category: string;
   subject: string;
   description: string;
   status: string;
   assigneeId: string | null;
   lastMessageAt: Date;
   resolvedAt: Date | null;
   closedAt: Date | null;
   createdAt: Date;
   updatedAt: Date;
}): TicketView {
   return {
      id: row.id,
      category: row.category,
      subject: row.subject,
      description: row.description,
      status: row.status,
      assigneeId: row.assigneeId,
      lastMessageAt: iso(row.lastMessageAt),
      resolvedAt: isoOrNull(row.resolvedAt),
      closedAt: isoOrNull(row.closedAt),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
   };
}

function toAttachmentView(row: {
   id: string;
   fileName: string;
   contentType: string;
   sizeBytes: number;
   status: string;
   uploadedAt: Date | null;
}): TicketAttachmentView {
   return {
      id: row.id,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      status: row.status,
      uploadedAt: isoOrNull(row.uploadedAt),
   };
}

function toMessageView(row: {
   id: string;
   authorType: string;
   body: string;
   createdAt: Date;
}): TicketMessageView {
   return {
      id: row.id,
      authorType: row.authorType,
      body: row.body,
      createdAt: iso(row.createdAt),
   };
}

function buildMeta(page: number, limit: number, totalCount: number): PaginationMetadata {
   const totalPages = Math.max(1, Math.ceil(totalCount / limit));
   return {
      page,
      limit,
      totalCount,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
   };
}

function baseUrl(): string {
   return envConfig.BACKEND_URL.replace(/\/+$/, '');
}

function uploadSlotFor(attachment: { id: string; fileName: string }, expiresAtMs: number): UploadSlot {
   const signature = signLink(ATTACHMENT_UPLOAD_PURPOSE, attachment.id, expiresAtMs);
   return {
      attachmentId: attachment.id,
      fileName: attachment.fileName,
      uploadUrl: `${baseUrl()}/v1/support/attachments/${attachment.id}/upload?expires=${expiresAtMs}&sig=${signature}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
      maxBytes: MAX_ATTACHMENT_BYTES,
   };
}

/** Whether a status change is permitted. Staying in the same status is always allowed. */
export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
   return from === to || TICKET_STATUS_TRANSITIONS[from].includes(to);
}

// ── User-facing operations ──────────────────────────────────

/**
 * Creates a ticket and reserves one upload slot per attachment. The bytes are
 * sent separately to each slot's `uploadUrl`.
 */
export async function createSupportTicket(
   userId: string,
   input: CreateTicketInput,
   now: Date = new Date()
): Promise<{ ticket: TicketView; attachments: TicketAttachmentView[]; uploads: UploadSlot[] }> {
   assertAttachmentDeclarations(input.attachments);

   const row = await prisma.ticket.create({
      data: {
         userId,
         category: input.category,
         subject: input.subject,
         description: input.description,
         status: 'open',
         lastMessageAt: now,
         attachments: {
            create: input.attachments.map(attachment => ({
               fileName: attachment.fileName,
               contentType: attachment.contentType,
               sizeBytes: attachment.sizeBytes,
            })),
         },
         statusChanges: {
            create: { fromStatus: null, toStatus: 'open', actorType: 'user', actorId: userId },
         },
      },
      include: { attachments: { select: ATTACHMENT_SELECT, orderBy: { createdAt: 'asc' } } },
   });

   const expiresAtMs = now.getTime() + ATTACHMENT_UPLOAD_TTL_MS;
   return {
      ticket: toTicketView(row),
      attachments: row.attachments.map(toAttachmentView),
      uploads: row.attachments.map(attachment => uploadSlotFor(attachment, expiresAtMs)),
   };
}

export async function listUserTickets(
   userId: string,
   params: { page: number; limit: number; status?: TicketStatus }
): Promise<{ data: TicketView[]; meta: PaginationMetadata }> {
   const where = { userId, ...(params.status ? { status: params.status } : {}) };
   const [rows, totalCount] = await prisma.$transaction([
      prisma.ticket.findMany({
         where,
         orderBy: { lastMessageAt: 'desc' },
         skip: (params.page - 1) * params.limit,
         take: params.limit,
      }),
      prisma.ticket.count({ where }),
   ]);
   return {
      data: rows.map(toTicketView),
      meta: buildMeta(params.page, params.limit, totalCount),
   };
}

async function loadDetail(where: { id: string; userId?: string }): Promise<TicketDetailView> {
   const row = await prisma.ticket.findFirst({
      where,
      include: {
         messages: { orderBy: { createdAt: 'asc' } },
         attachments: { select: ATTACHMENT_SELECT, orderBy: { createdAt: 'asc' } },
         statusChanges: { orderBy: { createdAt: 'asc' } },
      },
   });
   if (!row) throw new TicketNotFoundError();

   return {
      ...toTicketView(row),
      userId: row.userId,
      messages: row.messages.map(toMessageView),
      attachments: row.attachments.map(toAttachmentView),
      statusHistory: row.statusChanges.map(change => ({
         fromStatus: change.fromStatus,
         toStatus: change.toStatus,
         actorType: change.actorType,
         createdAt: iso(change.createdAt),
      })),
   };
}

/** One of the caller's own tickets. Other users' tickets look missing. */
export function getUserTicket(userId: string, ticketId: string): Promise<TicketDetailView> {
   return loadDetail({ id: ticketId, userId });
}

/** A user reply. A reply on a `waiting` or `resolved` ticket reopens it. */
export async function addUserMessage(
   userId: string,
   ticketId: string,
   body: string,
   now: Date = new Date()
): Promise<TicketMessageView> {
   const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, userId },
      select: { id: true, status: true },
   });
   if (!ticket) throw new TicketNotFoundError();
   if (ticket.status === 'closed') throw new TicketClosedError();

   const reopens = ticket.status === 'waiting' || ticket.status === 'resolved';
   const message = await prisma.$transaction(async tx => {
      const created = await tx.ticketMessage.create({
         data: { ticketId, authorType: 'user', authorId: userId, body },
      });
      await tx.ticket.update({
         where: { id: ticketId },
         data: { lastMessageAt: now, ...(reopens ? { status: 'open' } : {}) },
      });
      if (reopens) {
         await tx.ticketStatusChange.create({
            data: {
               ticketId,
               fromStatus: ticket.status,
               toStatus: 'open',
               actorType: 'user',
               actorId: userId,
               createdAt: now,
            },
         });
      }
      return created;
   });
   return toMessageView(message);
}

/** Bytes of an uploaded attachment on one of the caller's tickets. */
export async function getUserAttachment(
   userId: string,
   ticketId: string,
   attachmentId: string
): Promise<{ fileName: string; contentType: string; content: Buffer }> {
   return loadAttachment({ id: attachmentId, ticket: { id: ticketId, userId } });
}

async function loadAttachment(where: {
   id: string;
   ticket: { id: string; userId?: string };
}): Promise<{ fileName: string; contentType: string; content: Buffer }> {
   const row = await prisma.ticketAttachment.findFirst({
      where,
      select: { fileName: true, contentType: true, content: true, status: true },
   });
   if (!row || row.status !== 'uploaded' || !row.content) throw new AttachmentNotFoundError();
   return { fileName: row.fileName, contentType: row.contentType, content: Buffer.from(row.content) };
}

/**
 * Accepts the bytes for one attachment. The signed link authorises the upload,
 * and the bytes must match the declared size and type. Only one upload is
 * accepted per attachment.
 */
export async function storeAttachmentUpload(
   attachmentId: string,
   expiresMs: number,
   signature: string,
   bytes: Buffer,
   now: Date = new Date()
): Promise<TicketAttachmentView> {
   if (!verifyLink(ATTACHMENT_UPLOAD_PURPOSE, attachmentId, expiresMs, signature, now.getTime())) {
      throw new AttachmentUploadError('Upload link is invalid or has expired', 403);
   }

   const attachment = await prisma.ticketAttachment.findUnique({
      where: { id: attachmentId },
      select: { id: true, status: true, contentType: true, sizeBytes: true },
   });
   if (!attachment) throw new AttachmentUploadError('Attachment not found', 404);
   if (attachment.status !== 'pending') {
      throw new AttachmentUploadError('This attachment has already been uploaded', 409);
   }

   verifyUploadedBytes(bytes, attachment.contentType, attachment.sizeBytes);

   const sha256 = createHash('sha256').update(bytes).digest('hex');
   const claimed = await prisma.ticketAttachment.updateMany({
      where: { id: attachmentId, status: 'pending' },
      data: { status: 'uploaded', content: new Uint8Array(bytes), sha256, uploadedAt: now },
   });
   if (claimed.count === 0) {
      throw new AttachmentUploadError('This attachment has already been uploaded', 409);
   }

   const stored = await prisma.ticketAttachment.findUnique({
      where: { id: attachmentId },
      select: ATTACHMENT_SELECT,
   });
   if (!stored) throw new AttachmentUploadError('Attachment not found', 404);
   return toAttachmentView(stored);
}

// ── Agent operations ────────────────────────────────────────

export async function listTicketsForAgents(params: {
   page: number;
   limit: number;
   status?: TicketStatus;
   assigneeId?: string;
}): Promise<{ data: TicketView[]; meta: PaginationMetadata }> {
   const where = {
      ...(params.status ? { status: params.status } : {}),
      ...(params.assigneeId ? { assigneeId: params.assigneeId } : {}),
   };
   const [rows, totalCount] = await prisma.$transaction([
      prisma.ticket.findMany({
         where,
         orderBy: { lastMessageAt: 'desc' },
         skip: (params.page - 1) * params.limit,
         take: params.limit,
      }),
      prisma.ticket.count({ where }),
   ]);
   return {
      data: rows.map(toTicketView),
      meta: buildMeta(params.page, params.limit, totalCount),
   };
}

export function getTicketForAgent(ticketId: string): Promise<TicketDetailView> {
   return loadDetail({ id: ticketId });
}

export function getAttachmentForAgent(
   ticketId: string,
   attachmentId: string
): Promise<{ fileName: string; contentType: string; content: Buffer }> {
   return loadAttachment({ id: attachmentId, ticket: { id: ticketId } });
}

export async function assignTicket(ticketId: string, assigneeId: string): Promise<TicketView> {
   const existing = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { id: true } });
   if (!existing) throw new TicketNotFoundError();
   const row = await prisma.ticket.update({ where: { id: ticketId }, data: { assigneeId } });
   return toTicketView(row);
}

/** Sets a status explicitly. Each change is recorded with its timestamp. */
export async function setTicketStatus(
   ticketId: string,
   agentId: string,
   toStatus: TicketStatus,
   now: Date = new Date()
): Promise<TicketView> {
   const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, status: true },
   });
   if (!ticket) throw new TicketNotFoundError();

   const from = ticket.status as TicketStatus;
   if (from !== toStatus) {
      if (!canTransition(from, toStatus)) throw new InvalidStatusTransitionError(from, toStatus);
      await prisma.$transaction(async tx => {
         await tx.ticket.update({
            where: { id: ticket.id },
            data: {
               status: toStatus,
               ...(toStatus === 'resolved' ? { resolvedAt: now } : {}),
               ...(toStatus === 'closed' ? { closedAt: now } : {}),
            },
         });
         await tx.ticketStatusChange.create({
            data: {
               ticketId: ticket.id,
               fromStatus: ticket.status,
               toStatus,
               actorType: 'agent',
               actorId: agentId,
               createdAt: now,
            },
         });
      });
   }
   return toTicketView(await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } }));
}

/**
 * Agent reply. Moves an `open` ticket to `waiting` unless a status is given.
 * The user is emailed once for this message.
 */
export async function replyAsAgent(
   ticketId: string,
   agentId: string,
   input: { body: string; status?: TicketStatus },
   now: Date = new Date()
): Promise<{ message: TicketMessageView; notification: NotificationOutcome }> {
   const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, status: true },
   });
   if (!ticket) throw new TicketNotFoundError();
   if (ticket.status === 'closed') throw new TicketClosedError();

   const from = ticket.status as TicketStatus;
   const next: TicketStatus = input.status ?? (from === 'open' ? 'waiting' : from);
   if (!canTransition(from, next)) throw new InvalidStatusTransitionError(from, next);

   const message = await prisma.$transaction(async tx => {
      const created = await tx.ticketMessage.create({
         data: { ticketId, authorType: 'agent', authorId: agentId, body: input.body },
      });
      await tx.ticket.update({ where: { id: ticketId }, data: { lastMessageAt: now } });
      if (next !== from) {
         await tx.ticket.update({
            where: { id: ticketId },
            data: {
               status: next,
               ...(next === 'resolved' ? { resolvedAt: now } : {}),
               ...(next === 'closed' ? { closedAt: now } : {}),
            },
         });
         await tx.ticketStatusChange.create({
            data: {
               ticketId,
               fromStatus: from,
               toStatus: next,
               actorType: 'agent',
               actorId: agentId,
               createdAt: now,
            },
         });
      }
      return created;
   });

   const notification = await notifyUserOfAgentReply(message.id, now);
   return { message: toMessageView(message), notification };
}

// ── Notifications ───────────────────────────────────────────

export type NotificationOutcome = 'sent' | 'failed' | 'already_notified';

/**
 * Emails the ticket owner about an agent reply. The message's `notifiedAt` is
 * claimed first, so repeated calls for the same message send one email. A
 * failed send is not retried.
 */
export async function notifyUserOfAgentReply(
   messageId: string,
   now: Date = new Date()
): Promise<NotificationOutcome> {
   const claim = await prisma.ticketMessage.updateMany({
      where: { id: messageId, authorType: 'agent', notifiedAt: null },
      data: { notifiedAt: now },
   });
   if (claim.count === 0) return 'already_notified';

   const message = await prisma.ticketMessage.findUnique({
      where: { id: messageId },
      select: { ticketId: true },
   });
   if (!message) return 'failed';

   const ticket = await prisma.ticket.findUnique({
      where: { id: message.ticketId },
      select: { id: true, subject: true, userId: true },
   });
   if (!ticket) return 'failed';

   const owner = await prisma.user.findUnique({
      where: { id: ticket.userId },
      select: { email: true },
   });
   if (!owner) return 'failed';

   const link = `${envConfig.FRONTEND_URL.replace(/\/+$/, '')}/support/tickets/${ticket.id}`;
   const sent = await SendMail({
      to: owner.email,
      subject: 'New reply on your support ticket',
      text: `The support team has replied to your ticket "${ticket.subject}". View the reply: ${link}`,
   });
   return sent ? 'sent' : 'failed';
}
