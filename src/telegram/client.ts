import { Client } from "mtkruto";
import { load } from "@std/dotenv";
import { fromFileUrl, join, dirname } from "@std/path";

if (!Deno.env.get("TG_API_ID")) {
  await load({ export: true });
}

const currentDir = dirname(fromFileUrl(import.meta.url));
const sessionsPath = join(currentDir, "..", "..", "sessions.json");
const triggersPath = join(currentDir, "..", "..", "triggers.json");

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

type StoredTrigger = {
  message: string;
  reply: string;
};

type TriggerStore = Record<string, StoredTrigger[]>;

type ClientState = {
  client: Client;
  isConnected: boolean;
  isMessageListenerAttached: boolean;
  meId?: number;
  connectPromise?: Promise<void>;
};

const triggerSubscriptions = new Map<string, Map<string, string>>();
const clientStates = new Map<string, ClientState>();

function createClientInstance() {
  return new Client({
    apiId: Number(Deno.env.get("TG_API_ID")),
    apiHash: Deno.env.get("TG_API_HASH")!,
  });
}

const registrationClient = createClientInstance();

export async function login(username: string) {
  await ensureClient(username);
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

async function ensureClient(username: string): Promise<ClientState> {
  const normalized = username.trim();
  if (!normalized) {
    throw new Error("Username is required");
  }

  let state = clientStates.get(normalized);
  if (!state) {
    state = {
      client: createClientInstance(),
      isConnected: false,
      isMessageListenerAttached: false,
    };
    clientStates.set(normalized, state);
  }

  if (state.isConnected) {
    return state;
  }

  if (!state.connectPromise) {
    state.connectPromise = (async () => {
      const sessions = await loadSessions();
      const authString = sessions[normalized];
      if (!authString) {
        throw new Error(`No saved auth string for ${normalized}. Run manual login first.`);
      }

      await state.client.importAuthString(authString);
      await state.client.start();
      const me = await state.client.getMe();
      state.meId = me.id;
      state.isConnected = true;
      console.log(`Logged in as ${normalized} from saved auth string`);

      if (!state.isMessageListenerAttached) {
        state.client.on("message", (ctx) => handleIncomingMessage(normalized, state, ctx));
        state.isMessageListenerAttached = true;
        console.log(`📡 Attached message listener for @${normalized}`);
      }
    })()
      .finally(() => {
        state.connectPromise = undefined;
      });
  }

  await state.connectPromise;
  return state;
}

async function loadTriggerStore(): Promise<TriggerStore> {
  try {
    const raw = await Deno.readTextFile(triggersPath);
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveTriggerStore(store: TriggerStore) {
  await Deno.writeTextFile(triggersPath, JSON.stringify(store, null, 2));
}

function getUserTriggerMap(username: string) {
  const normalized = username.trim();
  if (!triggerSubscriptions.has(normalized)) {
    triggerSubscriptions.set(normalized, new Map());
  }
  return triggerSubscriptions.get(normalized)!;
}

async function persistTrigger(username: string, message: string, reply: string) {
  const store = await loadTriggerStore();
  const triggers = store[username] ?? [];
  const idx = triggers.findIndex((entry) => entry.message === message);

  if (idx >= 0) {
    triggers[idx].reply = reply;
  } else {
    triggers.push({ message, reply });
  }

  store[username] = triggers;
  await saveTriggerStore(store);
}

async function hydrateTriggersFromDisk() {
  const store = await loadTriggerStore();
  for (const [username, triggers] of Object.entries(store)) {
    const perUser = getUserTriggerMap(username);
    for (const { message, reply } of triggers) {
      perUser.set(message, reply);
    }
    if (triggers.length > 0) {
      await ensureClient(username).catch((error) => {
        console.error(`Failed to hydrate triggers for @${username}:`, error);
      });
    }
  }
}

await hydrateTriggersFromDisk();

export async function registerUserFirstStep(phone: string) {
  const normalizedPhone = phone.trim();
  if (!normalizedPhone) {
    throw new Error("Phone number is required");
  }

  if (pendingRegistration) {
    throw new Error("Another registration is already in progress");
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
    await registrationClient.disconnect().catch(() => {});

    await registrationClient.start({
      phone: () => phone,
      code: () => code.promise,
      password: () => password.promise,
    });

    const me = await registrationClient.getMe();

    const newAuth = await registrationClient.exportAuthString();
    await persistSession(me.username || "unknown_user", newAuth);
    console.log(`Registration completed for ${me.username ?? phone}`);
  } finally {
    await registrationClient.disconnect().catch(() => {});
    pendingRegistration = null;
  }
}

export async function sendMessageToUser(from: string, username: string, text: string) {
  const state = await ensureClient(from);
  await state.client.sendMessage(username, text);
}

export async function sendToMe(from: string, text: string) {
  const state = await ensureClient(from);
  await state.client.sendMessage("me", text);
}

export async function listingForMessages(to: string, message: string, reply: string) {
  const normalizedUser = to.trim();
  const normalizedMessage = message.trim();

  if (!normalizedUser) {
    throw new Error("Field `to` must not be empty");
  }

  if (!normalizedMessage) {
    throw new Error("Field `trigger` must not be empty");
  }

  await ensureClient(normalizedUser);

  const perUser = getUserTriggerMap(normalizedUser);
  const alreadyExists = perUser.has(normalizedMessage);
  perUser.set(normalizedMessage, reply);
  await persistTrigger(normalizedUser, normalizedMessage, reply);

  const statusEmoji = alreadyExists ? "♻️ Updated" : "✅ Registered";
  console.log(`${statusEmoji} trigger "${normalizedMessage}" for @${normalizedUser} (total: ${perUser.size})`);
}

export async function loginManually() {
  await registrationClient.disconnect().catch(() => {});

  await registrationClient.start({
    phone: () => prompt("Enter phone number:")!,
    code: () => prompt("Enter code:")!,
    password: () => prompt("Enter 2FA password (or leave empty):")!,
  });

  const me = await registrationClient.getMe();
 
  console.log(me);

  console.log("Logged in, exporting auth string...");
  const newAuth = await registrationClient.exportAuthString();
  await persistSession(me.username || "unknown_user", newAuth);
  console.log("Auth string saved to sessions.json");

  await registrationClient.disconnect().catch(() => {});
}

export async function clearTriggersForUser(username: string) {
  const normalizedUser = username.trim();
  if (!normalizedUser) {
    throw new Error("Field `to` must not be empty");
  }
  const perUser = getUserTriggerMap(normalizedUser);
  perUser.clear();
  const store = await loadTriggerStore();
  delete store[normalizedUser];
  await saveTriggerStore(store);
}

async function handleIncomingMessage(ownerUsername: string, state: ClientState, ctx: any) {
  if (state.meId && ctx.from?.id === state.meId) {
    return;
  }

  const fromUsername = ctx.from?.username;
  const fallbackName = ctx.from?.firstName || "Unknown";
  const text = (ctx.message?.text || "").trim();
  
  console.log(`📨 Message for @${ownerUsername} from @${fromUsername ?? fallbackName}: ${text || "[no text]"}`);

  if (!fromUsername) {
    console.warn(`⚠️ Cannot reply to message for @${ownerUsername}: sender has no username`);
    return;
  }

  if (!text) {
    return;
  }

  const perUser = triggerSubscriptions.get(ownerUsername);
  const reply = perUser?.get(text);
  if (!reply) {
    return;
  }

  await state.client.sendMessage(fromUsername, reply);
}