import type { Request, Response, NextFunction } from 'express';

/**
 * Express middleware that checks for UI_TOKEN when set.
 * Accepts Bearer token in Authorization header or ?token= query param.
 * If UI_TOKEN env var is not set, all requests pass through.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const uiToken = process.env.UI_TOKEN;
  if (!uiToken) {
    next();
    return;
  }

  const authHeader = req.headers['authorization'];
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
  const provided = bearer ?? queryToken;

  if (!provided || provided !== uiToken) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing UI_TOKEN.' });
    return;
  }

  next();
}
