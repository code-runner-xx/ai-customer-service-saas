import "server-only";

import { createClient } from "@supabase/supabase-js";

/**
 * Service Role 客户端:绕过 RLS。
 * 仅允许在 Route Handler / Server Action / 其他服务端代码中调用。
 * 所有业务查询必须显式带 `where user_id = tenantId`。
 */
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  );
}
