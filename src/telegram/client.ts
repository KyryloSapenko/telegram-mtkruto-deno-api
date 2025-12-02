import { Client } from "mtkruto";
import { load } from "@std/dotenv";
import { fromFileUrl, join, dirname } from "@std/path";

if (!Deno.env.get("TG_API_ID")) {
  await load({ export: true });
}

const currentDir = dirname(fromFileUrl(import.meta.url));
const sessionsPath = join(currentDir, "..", "..", "sessions.json");

let isConnected = false;
let currentUsername: string | null = null;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type PendingRegistration = {
  phone: string;
  code: Deferred<string>;
  password: Deferred<string>;
  startPromise: Promise<void>;
};

let pendingRegistration: PendingRegistration | null = null;

export const client = new Client({
  apiId: Number(Deno.env.get("TG_API_ID")),
  apiHash: Deno.env.get("TG_API_HASH")!,
});

export async function login(username: string) {
  if (isConnected && currentUsername === username) {
    return;
  }

  if (isConnected && currentUsername !== username) {
    await client.disconnect();
    isConnected = false;
    currentUsername = null;
  }

  const sessions = await loadSessions();
  const authString = sessions[username] ?? null;

  if (!authString) {
    throw new Error(`No saved auth string for ${username}. Run manual login first.`);
  }

  await client.importAuthString(authString);
  await client.start();
  isConnected = true;
  currentUsername = username;
  console.log(`Logged in as ${username} from saved auth string`);
}

async function loadSessions(): Promise<Record<string, string>> {
  try {
    const raw = await Deno.readTextFile(sessionsPath);
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function persistSession(username: string, authString: string) {
  const sessions = await loadSessions();
  sessions[username] = authString;
  await Deno.writeTextFile(sessionsPath, JSON.stringify(sessions, null, 2));
}

export async function registerUserFirstStep(phone: string) {
  const normalizedPhone = phone.trim();
  if (!normalizedPhone) {
    throw new Error("Phone number is required");
  }

  if (pendingRegistration) {
    throw new Error("Another registration is already in progress");
  }

  if (isConnected) {
    await client.disconnect();
    isConnected = false;
    currentUsername = null;
  }

  const codeDeferred = createDeferred<string>();
  const passwordDeferred = createDeferred<string>();

  const startPromise = runRegistrationFlow(normalizedPhone, codeDeferred, passwordDeferred);

  pendingRegistration = {
    phone: normalizedPhone,
    code: codeDeferred,
    password: passwordDeferred,
    startPromise,
  };

  return { status: "code_sent" };
}

export async function registerUserSecondStep(phone: string, code: string, password?: string) {
  if (!pendingRegistration) {
    throw new Error("No pending registration. Call the first step again.");
  }

  const normalizedPhone = phone.trim();
  if (pendingRegistration.phone !== normalizedPhone) {
    throw new Error("Phone number does not match the pending registration");
  }

  pendingRegistration.code.resolve(code.trim());
  pendingRegistration.password.resolve((password ?? "").trim());

  await pendingRegistration.startPromise;
  return { status: "registered" };
}

async function runRegistrationFlow(
  phone: string,
  code: Deferred<string>,
  password: Deferred<string>,
) {
  try {
    await client.start({
      phone: () => phone,
      code: () => code.promise,
      password: () => password.promise,
    });

    const me = await client.getMe();
    isConnected = true;
    currentUsername = me.username || null;

    const newAuth = await client.exportAuthString();
    await persistSession(me.username || "unknown_user", newAuth);
    console.log(`Registration completed for ${me.username ?? phone}`);
  } finally {
    pendingRegistration = null;
  }
}

export async function sendMessageToUser(from: string, username: string, text: string) {
  await login(from);
  await client.sendMessage(username, text);
}

export async function sendToMe(from: string, text: string) {
  await login(from);
  await client.sendMessage("me", text);
}

export async function listingForMessages(to: string, message: string, triggerfunction: (from: string) => Promise<void>) {
  await login(to);
  console.log("✅ Listening for messages...");
  client.on("message", async (ctx) => {
  const meId = await client.getMe().then((me) => me.id);  
  if (ctx.from.id === meId) return
    
  const from = ctx.from?.username || ctx.from?.firstName || "Unknown";
  const text = ctx.message.text || "[no text]";
  
  console.log(`📨 Message from @${from}: ${text}`);

  if (text === message) {    
    await triggerfunction(from);
  }
});

}

async function loginManually() {
  await client.start({
      phone: () => prompt("Enter phone number:")!,
      code: () => prompt("Enter code:")!,
      password: () => prompt("Enter 2FA password (or leave empty):")!,
    });

  const me = await client.getMe();
  isConnected = true;
  currentUsername = me.username || null;
 
  console.log(me);

  console.log("Logged in, exporting auth string...");
  const newAuth = await client.exportAuthString();
  await persistSession(me.username || "unknown_user", newAuth);
  console.log("Auth string saved to sessions.json");
}