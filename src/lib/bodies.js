/**
 * The request body parsers of the platform: a size limit each, and never
 * inflated. No page of the application sends a compressed body, and inflating
 * one costs the server work for whoever sends it, before sign-in included
 * (GHSA-27r3-jxmh-p828). A body sent with a Content-Encoding is refused (415,
 * answered `server.bad_request`).
 *
 *   jsonBody('4kb')   application/json → req.body
 *   rawBody(bytes)    any type → req.body as a Buffer (a diagram, a zip)
 */
import express from 'express';

export const jsonBody = (limit) => express.json({ limit, inflate: false });

export const rawBody = (limit) => express.raw({ type: () => true, limit, inflate: false });
