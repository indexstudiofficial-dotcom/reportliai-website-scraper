// ============================================================
// WEBSITE RAW TEXT SCRAPER
// VERSION: 2026-09-25-RAW-V1
//
// PURPOSE:
// 1. Discover website pages
// 2. Send pages to Cloudflare Queue
// 3. Queue consumer fetches each page
// 4. Extract raw visible text
// 5. Save directly to business_data
//
// NO AI
// NO scrape_jobs
// NO scrape_urls
// ============================================================


// ============================================================
// MAIN WORKER
// ============================================================

export default {
    async fetch(request, env) {
        try {
            // ------------------------------------------------
            // CORS
            // ------------------------------------------------

            if (request.method === "OPTIONS") {
                return new Response(null, {
                    status: 204,
                    headers: corsHeaders()
                });
            }

            if (request.method !== "POST") {
                return json({
                    success: false,
                    error: "Use POST"
                }, 405);
            }

            // ------------------------------------------------
            // READ REQUEST
            // ------------------------------------------------

            const body = await request.json();

            const applicationId = String(
                body.application_id || ""
            ).trim();

            const domain = String(
                body.domain || ""
            ).trim();

            if (!applicationId) {
                return json({
                    success: false,
                    error: "application_id is required"
                }, 400);
            }

            if (!domain) {
                return json({
                    success: false,
                    error: "domain is required"
                }, 400);
            }

            // ------------------------------------------------
            // CHECK ENVIRONMENT
            // ------------------------------------------------

            if (!env.SUPABASE_URL) {
                throw new Error(
                    "SUPABASE_URL is missing."
                );
            }

            if (!env.SUPABASE_SERVICE_ROLE_KEY) {
                throw new Error(
                    "SUPABASE_SERVICE_ROLE_KEY is missing."
                );
            }

            if (!env.SCRAPE_QUEUE) {
                throw new Error(
                    "SCRAPE_QUEUE binding is missing."
                );
            }

            // ------------------------------------------------
            // NORMALIZE DOMAIN
            // ------------------------------------------------

            const website = normalizeDomain(domain);

            // ------------------------------------------------
            // DISCOVER WEBSITE PAGES
            // ------------------------------------------------

            const urls = await discoverPages(website);

            if (urls.length === 0) {
                return json({
                    success: false,
                    error: "No website pages found.",
                    website
                }, 404);
            }

            // ------------------------------------------------
            // LIMIT
            // ------------------------------------------------

            const MAX_PAGES = 5000;

            const selectedUrls = urls.slice(
                0,
                MAX_PAGES
            );

            // ------------------------------------------------
            // SEND PAGES TO CLOUDFLARE QUEUE
            // ------------------------------------------------

            const messages = selectedUrls.map((url) => ({
                application_id: applicationId,
                url
            }));

            // Cloudflare Queue messages
            // are sent in batches.
            const BATCH_SIZE = 100;

            for (
                let i = 0;
                i < messages.length;
                i += BATCH_SIZE
            ) {
                const batch = messages.slice(
                    i,
                    i + BATCH_SIZE
                );

                await env.SCRAPE_QUEUE.sendBatch(
                    batch.map((message) => ({
                        body: message
                    }))
                );
            }

            // ------------------------------------------------
            // RETURN
            // ------------------------------------------------

            return json({
                success: true,
                worker_version: "2026-09-25-RAW-V1",
                application_id: applicationId,
                website,
                pages_found: urls.length,
                pages_queued: selectedUrls.length,
                message:
                    "Pages discovered and queued for scraping."
            });

        } catch (error) {

            console.error(
                "START ERROR:",
                error
            );

            return json({
                success: false,
                worker_version: "2026-09-25-RAW-V1",
                error: error.message
            }, 500);
        }
    },


    // ========================================================
    // CLOUDFLARE QUEUE CONSUMER
    // ========================================================

    async queue(batch, env) {

        for (const message of batch.messages) {

            try {

                const data = message.body;

                // ------------------------------------------------
                // VALIDATE MESSAGE
                // ------------------------------------------------

                if (
                    !data ||
                    !data.application_id ||
                    !data.url
                ) {
                    throw new Error(
                        "Invalid queue message."
                    );
                }

                const applicationId =
                    String(data.application_id).trim();

                const url =
                    String(data.url).trim();

                // ------------------------------------------------
                // SCRAPE PAGE
                // ------------------------------------------------

                console.log(
                    "Scraping:",
                    url
                );

                const page = await scrapePage(url);

                // ------------------------------------------------
                // SAVE RAW TEXT
                // ------------------------------------------------

                await saveRawText(
                    env,
                    applicationId,
                    url,
                    page.text
                );

                console.log(
                    "Saved:",
                    url
                );

                // ------------------------------------------------
                // ACKNOWLEDGE MESSAGE
                // ------------------------------------------------

                message.ack();

            } catch (error) {

                console.error(
                    "QUEUE ERROR:",
                    error
                );

                // Retry the message.
                message.retry();
            }
        }
    }
};


// ============================================================
// DISCOVER WEBSITE PAGES
// ============================================================

async function discoverPages(website) {

    const urls = new Set();

    // --------------------------------------------------------
    // robots.txt
    // --------------------------------------------------------

    try {

        const robotsUrl =
            new URL(
                "/robots.txt",
                website
            ).href;

        const response =
            await fetch(
                robotsUrl,
                {
                    headers: {
                        "User-Agent":
                            "ReportliRawScraper/1.0"
                    }
                }
            );

        if (response.ok) {

            const robotsText =
                await response.text();

            const sitemapMatches =
                robotsText.match(
                    /^Sitemap:\s*(.+)$/gim
                );

            if (sitemapMatches) {

                for (
                    const line of sitemapMatches
                ) {

                    const sitemapUrl =
                        line
                            .replace(
                                /^Sitemap:\s*/i,
                                ""
                            )
                            .trim();

                    await discoverSitemap(
                        sitemapUrl,
                        website,
                        urls
                    );
                }
            }
        }

    } catch (error) {

        console.log(
            "robots.txt failed:",
            error.message
        );
    }

    // --------------------------------------------------------
    // Standard sitemap locations
    // --------------------------------------------------------

    const standardSitemaps = [
        "/sitemap.xml",
        "/sitemap_index.xml",
        "/sitemap-index.xml"
    ];

    for (
        const path of standardSitemaps
    ) {

        try {

            const sitemapUrl =
                new URL(
                    path,
                    website
                ).href;

            await discoverSitemap(
                sitemapUrl,
                website,
                urls
            );

        } catch (error) {

            console.log(
                "Sitemap failed:",
                path
            );
        }
    }

    // --------------------------------------------------------
    // Always include homepage
    // --------------------------------------------------------

    urls.add(
        website
    );

    return Array.from(urls);
}


// ============================================================
// DISCOVER SITEMAP
// ============================================================

async function discoverSitemap(
    sitemapUrl,
    website,
    urls,
    depth = 0
) {

    // Prevent infinite sitemap recursion.
    if (depth > 3) {
        return;
    }

    try {

        const response =
            await fetch(
                sitemapUrl,
                {
                    headers: {
                        "User-Agent":
                            "ReportliRawScraper/1.0"
                    }
                }
            );

        if (!response.ok) {
            return;
        }

        const xml =
            await response.text();

        // ----------------------------------------------------
        // Sitemap index
        // ----------------------------------------------------

        const sitemapMatches =
            [...xml.matchAll(
                /<sitemap[^>]*>[\s\S]*?<loc>\s*([^<]+)\s*<\/loc>[\s\S]*?<\/sitemap>/gi
            )];

        if (sitemapMatches.length > 0) {

            for (
                const match of sitemapMatches
            ) {

                const childSitemap =
                    decodeXml(match[1].trim());

                await discoverSitemap(
                    childSitemap,
                    website,
                    urls,
                    depth + 1
                );
            }
        }

        // ----------------------------------------------------
        // Normal sitemap URLs
        // ----------------------------------------------------

        const urlMatches =
            [...xml.matchAll(
                /<url[^>]*>[\s\S]*?<loc>\s*([^<]+)\s*<\/loc>[\s\S]*?<\/url>/gi
            )];

        for (
            const match of urlMatches
        ) {

            const pageUrl =
                decodeXml(match[1].trim());

            if (
                isSameOrigin(
                    pageUrl,
                    website
                )
            ) {

                urls.add(
                    normalizeUrl(pageUrl)
                );
            }

            if (urls.size >= 5000) {
                break;
            }
        }

    } catch (error) {

        console.log(
            "Sitemap error:",
            sitemapUrl,
            error.message
        );
    }
}


// ============================================================
// SCRAPE ONE PAGE
// ============================================================

async function scrapePage(url) {

    const controller =
        new AbortController();

    const timeout =
        setTimeout(
            () => controller.abort(),
            15000
        );

    try {

        const response =
            await fetch(
                url,
                {
                    signal: controller.signal,
                    headers: {
                        "User-Agent":
                            "ReportliRawScraper/1.0"
                    }
                }
            );

        if (!response.ok) {

            throw new Error(
                `HTTP ${response.status}`
            );
        }

        const contentType =
            response.headers.get(
                "content-type"
            ) || "";

        // Only process HTML pages.
        if (
            !contentType.includes(
                "text/html"
            )
        ) {

            throw new Error(
                `Not an HTML page: ${contentType}`
            );
        }

        // ----------------------------------------------------
        // Prevent extremely large pages.
        // ----------------------------------------------------

        const contentLength =
            Number(
                response.headers.get(
                    "content-length"
                ) || 0
            );

        if (
            contentLength > 5_000_000
        ) {

            throw new Error(
                "Page is larger than 5 MB."
            );
        }

        const html =
            await response.text();

        // ----------------------------------------------------
        // Extract visible text.
        // ----------------------------------------------------

        const text =
            extractVisibleText(
                html
            );

        if (!text) {

            throw new Error(
                "No visible text found."
            );
        }

        return {
            text
        };

    } finally {

        clearTimeout(
            timeout
        );
    }
}


// ============================================================
// EXTRACT VISIBLE TEXT
// ============================================================

function extractVisibleText(html) {

    let content = html;

    // --------------------------------------------------------
    // Remove things that aren't useful page text.
    // --------------------------------------------------------

    content =
        content.replace(
            /<script\b[^>]*>[\s\S]*?<\/script>/gi,
            " "
        );

    content =
        content.replace(
            /<style\b[^>]*>[\s\S]*?<\/style>/gi,
            " "
        );

    content =
        content.replace(
            /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,
            " "
        );

    content =
        content.replace(
            /<svg\b[^>]*>[\s\S]*?<\/svg>/gi,
            " "
        );

    content =
        content.replace(
            /<template\b[^>]*>[\s\S]*?<\/template>/gi,
            " "
        );

    // --------------------------------------------------------
    // Convert common block elements to new lines.
    // --------------------------------------------------------

    content =
        content.replace(
            /<\/(p|div|section|article|header|footer|main|aside|nav|li|ul|ol|h1|h2|h3|h4|h5|h6|br|tr)>/gi,
            "\n"
        );

    // --------------------------------------------------------
    // Remove remaining HTML tags.
    // --------------------------------------------------------

    content =
        content.replace(
            /<[^>]+>/g,
            " "
        );

    // --------------------------------------------------------
    // Decode HTML entities.
    // --------------------------------------------------------

    content =
        decodeHtmlEntities(
            content
        );

    // --------------------------------------------------------
    // Normalize whitespace.
    // --------------------------------------------------------

    content =
        content.replace(
            /\r/g,
            ""
        );

    content =
        content.replace(
            /[ \t]+/g,
            " "
        );

    content =
        content.replace(
            /\n[ \t]+/g,
            "\n"
        );

    content =
        content.replace(
            /[ \t]+\n/g,
            "\n"
        );

    content =
        content.replace(
            /\n{3,}/g,
            "\n\n"
        );

    content =
        content.trim();

    // --------------------------------------------------------
    // Maximum raw text size.
    // --------------------------------------------------------

    const MAX_TEXT =
        500_000;

    if (
        content.length >
        MAX_TEXT
    ) {

        content =
            content.slice(
                0,
                MAX_TEXT
            );
    }

    return content;
}


// ============================================================
// SAVE RAW TEXT TO SUPABASE
// ============================================================

async function saveRawText(
    env,
    applicationId,
    sourceUrl,
    rawText
) {

    const url =
        `${env.SUPABASE_URL}/rest/v1/business_data`;

    const row = {

        application_id:
            applicationId,

        source_url:
            sourceUrl,

        field:
            "page",

        // IMPORTANT:
        // The complete raw text is stored directly
        // in the data column.
        data:
            rawText,

        updated_at:
            new Date().toISOString()
    };

    const response =
        await fetch(
            `${url}?on_conflict=application_id,source_url,field`,
            {
                method: "POST",

                headers: {
                    "apikey":
                        env.SUPABASE_SERVICE_ROLE_KEY,

                    "Authorization":
                        `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

                    "Content-Type":
                        "application/json",

                    "Prefer":
                        "resolution=merge-duplicates,return=minimal"
                },

                body:
                    JSON.stringify([
                        row
                    ])
            }
        );

    if (!response.ok) {

        const errorText =
            await response.text();

        throw new Error(
            `Supabase save failed: ${errorText}`
        );
    }
}


// ============================================================
// NORMALIZE DOMAIN
// ============================================================

function normalizeDomain(domain) {

    let value =
        domain.trim();

    if (
        !value.startsWith(
            "http://"
        ) &&
        !value.startsWith(
            "https://"
        )
    ) {

        value =
            "https://" +
            value;
    }

    const url =
        new URL(value);

    // Remove path.
    // The scraper starts from the website root.
    return `${url.protocol}//${url.host}`;
}


// ============================================================
// NORMALIZE URL
// ============================================================

function normalizeUrl(value) {

    try {

        const url =
            new URL(value);

        // Remove hash.
        url.hash = "";

        return url.href;

    } catch {

        return value;
    }
}


// ============================================================
// SAME ORIGIN
// ============================================================

function isSameOrigin(
    pageUrl,
    website
) {

    try {

        const page =
            new URL(pageUrl);

        const root =
            new URL(website);

        return (
            page.protocol ===
                root.protocol &&
            page.host ===
                root.host
        );

    } catch {

        return false;
    }
}


// ============================================================
// DECODE XML
// ============================================================

function decodeXml(value) {

    return value
        .replace(
            /&amp;/g,
            "&"
        )
        .replace(
            /&lt;/g,
            "<"
        )
        .replace(
            /&gt;/g,
            ">"
        )
        .replace(
            /&quot;/g,
            '"'
        )
        .replace(
            /&#39;/g,
            "'"
        );
}


// ============================================================
// DECODE HTML ENTITIES
// ============================================================

function decodeHtmlEntities(value) {

    return value
        .replace(
            /&nbsp;/gi,
            " "
        )
        .replace(
            /&amp;/gi,
            "&"
        )
        .replace(
            /&lt;/gi,
            "<"
        )
        .replace(
            /&gt;/gi,
            ">"
        )
        .replace(
            /&quot;/gi,
            '"'
        )
        .replace(
            /&#39;/gi,
            "'"
        )
        .replace(
            /&#x27;/gi,
            "'"
        );
}


// ============================================================
// JSON RESPONSE
// ============================================================

function json(
    data,
    status = 200
) {

    return new Response(
        JSON.stringify(
            data,
            null,
            2
        ),
        {
            status,

            headers: {
                "Content-Type":
                    "application/json",

                ...corsHeaders()
            }
        }
    );
}


// ============================================================
// CORS HEADERS
// ============================================================

function corsHeaders() {

    return {
        "Access-Control-Allow-Origin":
            "*",

        "Access-Control-Allow-Methods":
            "POST, OPTIONS",

        "Access-Control-Allow-Headers":
            "Content-Type, Authorization"
    };
                }
