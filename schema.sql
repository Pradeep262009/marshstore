-- Supabase Schema for Lightroom Presets Store

-- Create the orders table
CREATE TABLE IF NOT EXISTS public.orders (
    order_id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    amount TEXT NOT NULL,
    note TEXT,
    verified BOOLEAN DEFAULT FALSE,
    transaction_ref TEXT UNIQUE,
    download_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE,
    verified_at TIMESTAMP WITH TIME ZONE,
    email TEXT,
    client_ip TEXT,
    user_agent TEXT,
    device_info JSONB,
    geolocation JSONB,
    time_to_verify_ms INTEGER,
    last_download_at TIMESTAMP WITH TIME ZONE,
    last_download_ip TEXT,
    access_events JSONB DEFAULT '[]'::JSONB
);

-- Set up Row Level Security (RLS)
-- We want the backend server to have full access (via Service Role or Anon key with overrides),
-- but we don't want the public to access it directly from the frontend.
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- Allow all access to service role (which your backend will use)
CREATE POLICY "Enable all access for service role only" ON public.orders
    USING (true)
    WITH CHECK (true);
