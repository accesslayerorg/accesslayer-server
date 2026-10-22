// src/modules/status/status.controllers.ts
// Request handlers for platform status, history, and incidents (#1015).

import { Request, Response } from 'express';
import {
   createIncidentSchema,
   historyQuerySchema,
   incidentsQuerySchema,
} from './status.schemas';
import {
   createIncident,
   get30DayUptimeHistory,
   getIncidents,
   getLatestStatus,
} from './status.service';
import { StatusAdminRequest } from './status.auth';
import {
   ErrorCode,
   sendError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';

/**
 * GET /status
 * Returns current health of all services with status and last checked timestamp.
 * Responds in < 500ms using cached probe states.
 */
export async function getStatus(_req: Request, res: Response): Promise<void> {
   try {
      const result = await getLatestStatus();
      res.status(200).json({
         ...result,
         data: result,
      });
   } catch (error) {
      sendError(res, 500, ErrorCode.INTERNAL_ERROR, 'Failed to fetch platform status', [
         { message: error instanceof Error ? error.message : 'Unknown error' },
      ]);
   }
}

/**
 * GET /status/history
 * Returns 30-day uptime percentage per service.
 */
export async function getStatusHistory(req: Request, res: Response): Promise<void> {
   try {
      const parsedQuery = historyQuerySchema.safeParse(req.query);
      const windowDays = parsedQuery.success ? parsedQuery.data.windowDays : 30;

      const result = await get30DayUptimeHistory(windowDays);
      res.status(200).json({
         ...result,
         data: result,
      });
   } catch (error) {
      sendError(res, 500, ErrorCode.INTERNAL_ERROR, 'Failed to fetch status history', [
         { message: error instanceof Error ? error.message : 'Unknown error' },
      ]);
   }
}

/**
 * GET /status/incidents
 * Returns paginated incident log with title, services, start, and resolution.
 */
export async function getStatusIncidents(req: Request, res: Response): Promise<void> {
   try {
      const parsedQuery = incidentsQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
         sendError(
            res,
            400,
            ErrorCode.VALIDATION_ERROR,
            'Invalid query parameters',
            zodIssuesToDetails(parsedQuery.error.issues)
         );
         return;
      }

      const result = await getIncidents(parsedQuery.data);
      res.status(200).json({
         success: true,
         incidents: result.incidents,
         pagination: result.pagination,
         data: {
            incidents: result.incidents,
            pagination: result.pagination,
         },
      });
   } catch (error) {
      sendError(res, 500, ErrorCode.INTERNAL_ERROR, 'Failed to fetch incidents', [
         { message: error instanceof Error ? error.message : 'Unknown error' },
      ]);
   }
}

/**
 * POST /status/incidents
 * Creates a new incident record. Restricted to authenticated admin wallets.
 */
export async function postStatusIncident(
   req: StatusAdminRequest,
   res: Response
): Promise<void> {
   try {
      const parsedBody = createIncidentSchema.safeParse(req.body);
      if (!parsedBody.success) {
         sendError(
            res,
            400,
            ErrorCode.VALIDATION_ERROR,
            'Invalid incident payload',
            zodIssuesToDetails(parsedBody.error.issues)
         );
         return;
      }

      const incident = await createIncident(parsedBody.data, req.adminWallet);
      res.status(201).json({
         success: true,
         incident,
         data: incident,
         message: 'Incident created successfully',
      });
   } catch (error) {
      sendError(res, 500, ErrorCode.INTERNAL_ERROR, 'Failed to create incident', [
         { message: error instanceof Error ? error.message : 'Unknown error' },
      ]);
   }
}
