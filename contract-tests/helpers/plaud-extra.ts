import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";

/** Where the fake Plaud API listens. The server under test must be started with OAH_PLAUD_API_BASE set to this origin. */
export const FAKE_PLAUD_URL = process.env.OAH_PLAUD_FAKE_URL ?? "http://127.0.0.1:3298";

/** Builds an unsigned JWT-shaped string with the given claims. The app reads claims without verifying signatures. */
export function jwt(claims: Record<string, unknown>): string {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${enc({ alg: "HS256", typ: "JWT" })}.${enc(claims)}.ZmFrZQ`;
}

export const nowSec = () => Math.floor(Date.now() / 1000);

/** Starts the fake Plaud API unless one already answers. Returns the child process to stop, or null. */
export async function ensureFakePlaud(): Promise<ChildProcess | null> {
    if (await fakeUp()) return null;
    const port = new URL(FAKE_PLAUD_URL).port;
    const child = spawn(process.execPath, [resolve(__dirname, "../fakes/fake-plaud.mjs"), port], { stdio: "ignore" });
    for (let i = 0; i < 60; i++) {
        if (await fakeUp()) return child;
        await new Promise((r) => setTimeout(r, 250));
    }
    child.kill();
    throw new Error("fake Plaud API did not start");
}

async function fakeUp(): Promise<boolean> {
    try {
        const res = await fetch(`${FAKE_PLAUD_URL}/__control/health`);
        return res.ok;
    } catch {
        return false;
    }
}

/** Test-only control call to the fake Plaud API. */
export async function fakeControl(path: string, body: Record<string, unknown> = {}): Promise<void> {
    const res = await fetch(`${FAKE_PLAUD_URL}/__control${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`fake control ${path} failed: ${res.status}`);
}

export interface FakeRequest {
    method: string;
    path: string;
    query: string;
    ua: string | null;
    auth: "ut" | "wt" | "none" | "unknown";
    at: number;
}

export async function fakeRequests(): Promise<FakeRequest[]> {
    const res = await fetch(`${FAKE_PLAUD_URL}/__control/requests`);
    return ((await res.json()) as { requests: FakeRequest[] }).requests;
}

import { type APIRequestContext, expect, request } from "@playwright/test";
import { baseURL, credentials, freshCredentials } from "./api";

/** Sign-up and sign-in are limited per IP per minute on the server, so waits out 429 responses. */
async function postRetrying(api: APIRequestContext, path: string, data: unknown) {
    for (let i = 0; i < 40; i++) {
        const res = await api.post(path, { data });
        if (res.status() !== 429) return res;
        await new Promise((r) => setTimeout(r, 10_000));
    }
    throw new Error(`still rate limited: ${path}`);
}

/** A new account, signed in. Caller disposes it. */
export async function freshUser(label: string): Promise<APIRequestContext> {
    const api = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
    const who = freshCredentials(label);
    await postRetrying(api, "/api/auth/sign-up/email", who);
    const res = await postRetrying(api, "/api/auth/sign-in/email", { email: who.email, password: who.password });
    expect(res.status(), "sign-in").toBe(200);
    return api;
}

/** The shared contract account, signed in without creating it. Caller disposes it. */
export async function mainUser(): Promise<APIRequestContext> {
    const api = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
    const who = credentials();
    const res = await postRetrying(api, "/api/auth/sign-in/email", { email: who.email, password: who.password });
    expect(res.status(), "sign-in").toBe(200);
    return api;
}
