-- ============================================================
-- REPORTLI / MRME SCRAPER V2
-- Persistent crawl queue
-- ============================================================

-- ============================================================
-- 1. SCRAPE JOBS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.scrape_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    application_id text NOT NULL,

    website text NOT NULL,

    status text NOT NULL DEFAULT 'pending',

    total_urls integer NOT NULL DEFAULT 0,
    processed_urls integer NOT NULL DEFAULT 0,
    failed_urls integer NOT NULL DEFAULT 0,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_scrape_jobs_application
ON public.scrape_jobs (application_id);

CREATE INDEX IF NOT EXISTS idx_scrape_jobs_status
ON public.scrape_jobs (status);


-- ============================================================
-- 2. SCRAPE URL QUEUE
-- ============================================================

CREATE TABLE IF NOT EXISTS public.scrape_urls (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    job_id uuid NOT NULL
        REFERENCES public.scrape_jobs(id)
        ON DELETE CASCADE,

    application_id text NOT NULL,

    url text NOT NULL,

    status text NOT NULL DEFAULT 'pending',

    attempts integer NOT NULL DEFAULT 0,

    error text,

    discovered_from text,

    created_at timestamptz NOT NULL DEFAULT now(),

    processed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scrape_urls_job_url
ON public.scrape_urls (job_id, url);

CREATE INDEX IF NOT EXISTS idx_scrape_urls_job_status
ON public.scrape_urls (job_id, status);

CREATE INDEX IF NOT EXISTS idx_scrape_urls_application_status
ON public.scrape_urls (application_id, status);


-- ============================================================
-- 3. RLS
-- Worker uses service-role, so these don't block the Worker.
-- ============================================================

ALTER TABLE public.scrape_jobs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.scrape_urls ENABLE ROW LEVEL SECURITY;
