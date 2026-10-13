import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
  throw new Error("Missing required Supabase environment variables");
}

type SchemaSupabaseClient = SupabaseClient<any, any, string, any, any>;

const adminClients = new Map<string, SchemaSupabaseClient>();

function getActiveSchema(): string {
  return process.env.SUPABASE_SCHEMA || "public";
}

function createSchemaClient(schema: string): SchemaSupabaseClient {
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    db: {
      schema,
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        "Accept-Profile": schema,
        "Content-Profile": schema,
      },
    },
  });
}

function getAdminClient(): SchemaSupabaseClient {
  const schema = getActiveSchema();
  const cached = adminClients.get(schema);

  if (cached) {
    return cached;
  }

  const client = createSchemaClient(schema);
  adminClients.set(schema, client);

  return client;
}

// Admin singleton client — service role, elevated privileges
// Used for: profile lookups, access key hashing, admin operations
const adminClient = new Proxy({} as SchemaSupabaseClient, {
  get(_target, property, receiver) {
    const client = getAdminClient();
    const value = Reflect.get(client, property, receiver);

    if (typeof value === "function") {
      return value.bind(client);
    }

    return value;
  },
});

// Factory for disposable anon clients
// Each client is short-lived; used for auth flows and access-key lookups
// Prevents JWT tainting via the Afkode pattern
export function createDisposableAnonClient() {
  const activeSchema = getActiveSchema();

  return createClient(supabaseUrl, supabaseAnonKey, {
    db: {
      schema: activeSchema,
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        "Accept-Profile": activeSchema,
        "Content-Profile": activeSchema,
      },
    },
  });
}

export { adminClient };
