import type { Express, Request, Response } from 'express';
import { createRoomStore, isConstraintError } from '../room-store';
import { postToRoom } from '../room-coordinator';
import { sendJson } from '../lib/helpers';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function registerRoomRoutes(app: Express) {
  const store = createRoomStore();

  // POST /api/rooms — create a room
  app.post('/api/rooms', (req: Request, res: Response) => {
    try {
      const { name } = req.body;
      if (!isNonEmptyString(name)) {
        return sendJson(res, 400, { error: 'Missing or empty room name' });
      }
      const room = store.createRoom(name);
      sendJson(res, 201, { room });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  // GET /api/rooms — list all rooms
  app.get('/api/rooms', (_req: Request, res: Response) => {
    try {
      const rooms = store.listRooms();
      sendJson(res, 200, { rooms });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  // GET /api/rooms/:id — get room detail with members
  app.get('/api/rooms/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const room = store.getRoom(id);
      if (!room) {
        return sendJson(res, 404, { error: 'Room not found' });
      }
      const members = store.getMembers(id);
      sendJson(res, 200, { room, members });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  // DELETE /api/rooms/:id — delete a room
  app.delete('/api/rooms/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      store.deleteRoom(id);
      res.status(204).end();
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  // POST /api/rooms/:id/members — add a member to a room
  app.post('/api/rooms/:id/members', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { profileName, displayName, color, model } = req.body;

      if (!isNonEmptyString(profileName)) {
        return sendJson(res, 400, { error: 'Missing or empty profileName' });
      }
      if (!isNonEmptyString(displayName)) {
        return sendJson(res, 400, { error: 'Missing or empty displayName' });
      }

      const room = store.getRoom(id);
      if (!room) {
        return sendJson(res, 404, { error: 'Room not found' });
      }

      store.addMember(id, { profileName, displayName, color, model });
      sendJson(res, 201, { member: { roomId: id, profileName, displayName, color: color || '#888', model: model || '' } });
    } catch (error) {
      if (isConstraintError(error)) {
        return sendJson(res, 409, { error: 'Member already exists in this room' });
      }
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  // DELETE /api/rooms/:id/members/:profile — remove a member from a room
  app.delete('/api/rooms/:id/members/:profile', (req: Request, res: Response) => {
    try {
      const { id, profile } = req.params;
      store.removeMember(id, profile);
      res.status(204).end();
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  // GET /api/rooms/:id/messages — get messages for a room
  app.get('/api/rooms/:id/messages', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
      const before = typeof req.query.before === 'string' && req.query.before.trim().length > 0
        ? req.query.before
        : undefined;
      const messages = store.getMessages(id, limit, before);
      sendJson(res, 200, { messages });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  // POST /api/rooms/:id/messages — post a message to a room and trigger agents
  app.post('/api/rooms/:id/messages', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { content, sender, senderDisplayName, teamId } = req.body;

      if (!isNonEmptyString(content)) {
        return sendJson(res, 400, { error: 'Missing or empty message content' });
      }
      if (!isNonEmptyString(sender)) {
        return sendJson(res, 400, { error: 'Missing or empty sender' });
      }

      const { message, triggeredAgents } = await postToRoom(id, content, sender, senderDisplayName, teamId);
      sendJson(res, 201, { message, triggeredAgents });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
