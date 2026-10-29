// A thread that loses a rejection: a `worker` fails closed (exit 70), a `server-thread` lives on.
import { setTimeout as sleep } from "node:timers/promises";

void Promise.reject(new Error("thread lost it"));
await sleep(50);
