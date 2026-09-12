// Deno type declarations for Supabase Edge Functions

declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
};

// Suppress TypeScript errors for Deno imports
declare module 'https://deno.land/std@0.168.0/http/server.ts' {
  export function serve(handler: (req: Request) => Response | Promise<Response>): void;
}

declare module 'https://esm.sh/@supabase/supabase-js@2' {
  export function createClient(url: string, key: string): any;
}
