// ============================================================
// REPORTLI WEBSITE SCRAPER
// V4 - CLOUDFLARE QUEUES
// ============================================================
//
// INPUT:
//
// {
//   "application_id": "app-1790254969447",
//   "domain": "https://drjohnysdentalclinicpalakkad.com"
// }
//
//
//
// WHAT THIS WORKER DOES:
//
// 1. Receives application_id + domain
// 2. Discovers sitemap(s)
// 3. Finds all same-domain page URLs
// 4. Saves every URL into scrape_urls
// 5. Sends every page to Cloudflare Queue
// 6. Queue automatically processes pages
// 7. Fetches each page
// 8. Extracts raw visible text
// 9. Saves raw text into business_data
//
//
//
// BUSINESS_DATA:
//
// application_id = user's application
// source_url     = actual page URL
// field          = "page"
// data           = ALL extracted page text
//
//
//
// IMPORTANT:
//
// NO AI
// NO SUMMARIZATION
// NO CLASSIFICATION
// NO BUSINESS ANALYSIS
//
// This Worker only collects raw website data.
//
// ============================================================


// ============================================================
// VERSION
// ============================================================

const VERSION = "2026-09-25-V4";


// ============================================================
// CONFIGURATION
// ============================================================

// Maximum pages that one website can queue.
// Increase later if you need more.
const MAX_PAGES = 5000;


// Maximum sitemap files checked during discovery.
const MAX_SITEMAPS = 30;


// Maximum HTML size we accept for one page.
const MAX_HTML_BYTES = 5 * 1024 * 1024;


// Maximum raw text stored for one page.
const MAX_PAGE_TEXT_CHARS = 500000;


// Website request timeout.
const FETCH_TIMEOUT = 15000;


// ============================================================
// WORKER
// ============================================================

export default {

    // ========================================================
    // HTTP REQUEST
    // ========================================================

    async fetch(request, env, ctx) {

        // ----------------------------------------------------
        // CORS
        // ----------------------------------------------------

        if (request.method === "OPTIONS") {

            return new Response(null, {
                status: 204,
                headers: corsHeaders()
            });

        }


        // ----------------------------------------------------
        // Only POST
        // ----------------------------------------------------

        if (request.method !== "POST") {

            return jsonResponse(
                {
                    success: false,
                    error: "Only POST requests are allowed."
                },
                405
            );

        }


        try {

            const body =
                await request.json();


            // ------------------------------------------------
            // START
            // ------------------------------------------------
            //
            // {
            //   application_id: "...",
            //   domain: "https://example.com"
            // }
            //

            return await startScrape(
                body,
                env
            );


        } catch (error) {

            console.error(
                "HTTP ERROR:",
                error
            );


            return jsonResponse(
                {
                    success: false,
                    worker_version: VERSION,
                    error:
                        error?.message ||
                        String(error)
                },
                500
            );

        }

    },


    // ========================================================
    // CLOUDFLARE QUEUE CONSUMER
    // ========================================================

    async queue(batch, env, ctx) {

        console.log(
            `Queue received ${batch.messages.length} message(s).`
        );


        // ----------------------------------------------------
        // Process each page message one by one.
        //
        // We intentionally do NOT use forEach because
        // asynchronous work must be awaited.
        // ----------------------------------------------------

        for (
            const message
            of batch.messages
        ) {

            try {

                await processPageMessage(
                    message,
                    env
                );


                // --------------------------------------------
                // Successfully processed.
                // --------------------------------------------

                message.ack();


                console.log(
                    "Page completed:",
                    message.body?.url
                );


            } catch (error) {

                console.error(
                    "Page processing failed:",
                    message.body?.url,
                    error
                );


                // --------------------------------------------
                // Retry failed message.
                //
                // Cloudflare tracks attempts.
                // --------------------------------------------

                if (
                    message.attempts < 3
                ) {

                    message.retry({
                        delaySeconds: 10
                    });

                } else {

                    // ----------------------------------------
                    // We have reached our retry limit.
                    //
                    // Mark the database row as failed.
                    // ----------------------------------------

                    try {

                        await markPageFailed(
                            env,
                            message.body,
                            error?.message ||
                                String(error)
                        );

                    } catch (dbError) {

                        console.error(
                            "Could not mark page failed:",
                            dbError
                        );

                    }


                    // ----------------------------------------
                    // ACK it so it does not loop forever.
                    // ----------------------------------------

                    message.ack();

                }

            }

        }

    }

};


// ============================================================
// START SCRAPE
// ============================================================

async function startScrape(
    body,
    env
) {

    // --------------------------------------------------------
    // Read application ID
    // --------------------------------------------------------

    const applicationId =
        String(
            body.application_id || ""
        ).trim();


    // --------------------------------------------------------
    // Read domain
    // --------------------------------------------------------

    const domain =
        normalizeDomain(
            String(
                body.domain || ""
            ).trim()
        );


    // --------------------------------------------------------
    // Validation
    // --------------------------------------------------------

    if (!applicationId) {

        return jsonResponse(
            {
                success: false,
                error:
                    "application_id is required."
            },
            400
        );

    }


    if (!domain) {

        return jsonResponse(
            {
                success: false,
                error:
                    "domain must be a valid website URL."
            },
            400
        );

    }


    // --------------------------------------------------------
    // Check if this application already has an active job.
    // --------------------------------------------------------

    const activeJobs =
        await supabaseRequest(
            env,

            `/rest/v1/scrape_jobs?application_id=eq.${encodeURIComponent(applicationId)}&status=in.(pending,processing)&select=*`,

            {
                method: "GET"
            }
        );


    if (!activeJobs.ok) {

        throw new Error(
            `Could not check active jobs: ${activeJobs.text}`
        );

    }


    if (
        Array.isArray(activeJobs.data) &&
        activeJobs.data.length > 0
    ) {

        return jsonResponse({

            success: true,

            message:
                "A scrape is already running for this application.",

            worker_version:
                VERSION,

            job:
                activeJobs.data[0]

        });

    }


    // --------------------------------------------------------
    // Create scrape job
    // --------------------------------------------------------

    const jobResult =
        await supabaseRequest(
            env,

            `/rest/v1/scrape_jobs`,

            {
                method: "POST",

                headers: {
                    "Prefer":
                        "return=representation"
                },

                body:
                    JSON.stringify({

                        application_id:
                            applicationId,

                        website:
                            domain,

                        status:
                            "pending",

                        total_urls:
                            0,

                        processed_urls:
                            0,

                        failed_urls:
                            0

                    })
            }
        );


    if (!jobResult.ok) {

        throw new Error(
            `Could not create scrape job: ${jobResult.text}`
        );

    }


    const job =
        jobResult.data?.[0];


    if (!job?.id) {

        throw new Error(
            "Supabase did not return a job ID."
        );

    }


    const jobId =
        job.id;


    // ========================================================
    // DISCOVER ALL WEBSITE PAGES
    // ========================================================

    console.log(
        "Starting sitemap discovery:",
        domain
    );


    const discovery =
        await discoverWebsitePages(
            domain
        );


    // --------------------------------------------------------
    // Remove duplicate URLs.
    // --------------------------------------------------------

    let pageUrls =
        uniqueUrls(
            discovery.urls
        );


    // --------------------------------------------------------
    // Limit maximum pages.
    // --------------------------------------------------------

    pageUrls =
        pageUrls.slice(
            0,
            MAX_PAGES
        );


    // --------------------------------------------------------
    // If sitemap discovery returned nothing,
    // use homepage as fallback.
    // --------------------------------------------------------

    if (
        pageUrls.length === 0
    ) {

        pageUrls = [
            domain
        ];

    }


    // ========================================================
    // SAVE URL QUEUE TO SUPABASE
    // ========================================================

    const queueRows =
        pageUrls.map(
            (url) => {

                return {

                    job_id:
                        jobId,

                    application_id:
                        applicationId,

                    url:
                        url,

                    status:
                        "pending",

                    attempts:
                        0,

                    discovered_from:
                        discovery.source ||
                        domain

                };

            }
        );


    // --------------------------------------------------------
    // Insert in chunks.
    // --------------------------------------------------------

    const chunks =
        chunkArray(
            queueRows,
            500
        );


    for (
        const chunk
        of chunks
    ) {

        const result =
            await supabaseRequest(
                env,

                `/rest/v1/scrape_urls`,

                {
                    method: "POST",

                    headers: {
                        "Prefer":
                            "return=minimal"
                    },

                    body:
                        JSON.stringify(
                            chunk
                        )
                }
            );


        if (!result.ok) {

            throw new Error(
                `Could not save scrape URLs: ${result.text}`
            );

        }

    }


    // ========================================================
    // SEND PAGES TO CLOUDFLARE QUEUE
    // ========================================================

    //
    // Cloudflare sendBatch supports up to 100 messages.
    // We therefore send 100 messages at a time.
    //
    // The consumer itself is configured for only 2 pages
    // per invocation.
    //

    const messageChunks =
        chunkArray(
            queueRows,
            100
        );


    let messagesQueued =
        0;


    for (
        const chunk
        of messageChunks
    ) {

        const messages =
            chunk.map(
                (row) => {

                    return {

                        body: {

                            type:
                                "page",

                            job_id:
                                row.job_id,

                            scrape_url_id:
                                row.id,

                            application_id:
                                row.application_id,

                            url:
                                row.url

                        }

                    };

                }
            );


        await env.SCRAPE_QUEUE.sendBatch(
            messages
        );


        messagesQueued +=
            messages.length;

    }


    // ========================================================
    // UPDATE JOB
    // ========================================================

    const updateJob =
        await supabaseRequest(
            env,

            `/rest/v1/scrape_jobs?id=eq.${encodeURIComponent(jobId)}`,

            {
                method: "PATCH",

                headers: {
                    "Prefer":
                        "return=minimal"
                },

                body:
                    JSON.stringify({

                        status:
                            "processing",

                        total_urls:
                            pageUrls.length,

                        updated_at:
                            new Date().toISOString()

                    })
            }
        );


    if (!updateJob.ok) {

        throw new Error(
            `Could not update scrape job: ${updateJob.text}`
        );

    }


    // ========================================================
    // RETURN TO USER
    // ========================================================

    return jsonResponse({

        success: true,

        worker_version:
            VERSION,

        message:
            "Website crawl started. All discovered pages have been queued for automatic processing.",

        application_id:
            applicationId,

        website:
            domain,

        job_id:
            jobId,

        discovery: {

            sitemap_source:
                discovery.source,

            sitemaps_checked:
                discovery.sitemapsChecked,

            sitemap_errors:
                discovery.sitemapErrors,

            pages_found:
                pageUrls.length

        },

        queue: {

            messages_queued:
                messagesQueued,

            automatic:
                true

        },

        next:
            "No manual process request is required. Cloudflare Queue will process the pages automatically."

    });

}


// ============================================================
// PROCESS ONE PAGE
// ============================================================

async function processPageMessage(
    message,
    env
) {

    const body =
        message.body;


    if (
        !body ||
        body.type !== "page"
    ) {

        throw new Error(
            "Invalid queue message."
        );

    }


    const jobId =
        String(
            body.job_id || ""
        ).trim();


    const scrapeUrlId =
        String(
            body.scrape_url_id || ""
        ).trim();


    const applicationId =
        String(
            body.application_id || ""
        ).trim();


    const url =
        String(
            body.url || ""
        ).trim();


    if (
        !jobId ||
        !scrapeUrlId ||
        !applicationId ||
        !url
    ) {

        throw new Error(
            "Queue message is missing required fields."
        );

    }


    // ========================================================
    // MARK PAGE AS PROCESSING
    // ========================================================

    await updateScrapeUrl(
        env,
        scrapeUrlId,
        {

            status:
                "processing",

            attempts:
                message.attempts || 1

        }
    );


    // ========================================================
    // FETCH PAGE
    // ========================================================

    const pageResponse =
        await fetchPage(
            url
        );


    if (!pageResponse.ok) {

        throw new Error(
            pageResponse.error
        );

    }


    // ========================================================
    // EXTRACT RAW TEXT
    // ========================================================

    const extracted =
        extractPageText(
            pageResponse.html,
            url
        );


    if (!extracted.text) {

        throw new Error(
            "No visible text was found on this page."
        );

    }


    // ========================================================
    // SAVE RAW PAGE DATA
    // ========================================================

    //
    // IMPORTANT:
    //
    // field = "page"
    //
    // data = all raw page text
    //
    // No AI.
    // No analysis.
    //

    const businessRow = {

        application_id:
            applicationId,

        source_url:
            url,

        field:
            "page",

        data: {

            title:
                extracted.title,

            text:
                extracted.text,

            headings:
                extracted.headings

        },

        updated_at:
            new Date().toISOString()

    };


    const saveResult =
        await supabaseRequest(
            env,

            `/rest/v1/business_data?on_conflict=application_id%2Csource_url%2Cfield`,

            {
                method: "POST",

                headers: {

                    "Prefer":
                        "resolution=merge-duplicates,return=minimal"

                },

                body:
                    JSON.stringify(
                        [businessRow]
                    )

            }
        );


    if (!saveResult.ok) {

        throw new Error(
            `Could not save business_data: ${saveResult.text}`
        );

    }


    // ========================================================
    // MARK URL COMPLETE
    // ========================================================

    await updateScrapeUrl(
        env,
        scrapeUrlId,
        {

            status:
                "completed",

            processed_at:
                new Date().toISOString(),

            error:
                null

        }
    );


    // ========================================================
    // UPDATE JOB COUNTERS
    // ========================================================

    await updateJobCounters(
        env,
        jobId
    );


    // ========================================================
    // CHECK IF ENTIRE JOB IS FINISHED
    // ========================================================

    await markJobCompletedIfNecessary(
        env,
        jobId
    );

}


// ============================================================
// MARK PAGE FAILED
// ============================================================

async function markPageFailed(
    env,
    body,
    error
) {

    const scrapeUrlId =
        String(
            body.scrape_url_id || ""
        ).trim();


    const jobId =
        String(
            body.job_id || ""
        ).trim();


    if (!scrapeUrlId) {
        return;
    }


    await updateScrapeUrl(
        env,
        scrapeUrlId,
        {

            status:
                "failed",

            error:
                String(error).slice(
                    0,
                    5000
                )

        }
    );


    if (jobId) {

        await updateJobCounters(
            env,
            jobId
        );


        await markJobCompletedIfNecessary(
            env,
            jobId
        );

    }

}


// ============================================================
// DISCOVER WEBSITE PAGES
// ============================================================

async function discoverWebsitePages(
    domain
) {

    const origin =
        new URL(
            domain
        ).origin;


    // --------------------------------------------------------
    // Possible sitemap locations.
    // --------------------------------------------------------

    const sitemapCandidates = [

        `${origin}/sitemap.xml`,

        `${origin}/sitemap_index.xml`,

        `${origin}/sitemap-index.xml`

    ];


    // --------------------------------------------------------
    // Read robots.txt.
    // --------------------------------------------------------

    let robotsSitemaps =
        [];


    try {

        const robots =
            await fetchWithTimeout(
                `${origin}/robots.txt`,
                {
                    headers: {
                        "User-Agent":
                            "ReportliBot/1.0"
                    }
                },
                FETCH_TIMEOUT
            );


        if (robots.ok) {

            const text =
                await robots.text();


            robotsSitemaps =
                extractSitemapsFromRobots(
                    text
                );

        }

    } catch (error) {

        console.log(
            "robots.txt failed:",
            error?.message
        );

    }


    // --------------------------------------------------------
    // Sitemap queue.
    // --------------------------------------------------------

    const sitemapQueue =
        uniqueUrls([
            ...robotsSitemaps,
            ...sitemapCandidates
        ]);


    const checkedSitemaps =
        new Set();


    const discoveredPages =
        new Set();


    let sitemapErrors =
        0;


    let source =
        sitemapQueue[0] ||
        null;


    // ========================================================
    // PROCESS SITEMAPS
    // ========================================================

    while (

        sitemapQueue.length > 0 &&

        checkedSitemaps.size <
            MAX_SITEMAPS &&

        discoveredPages.size <
            MAX_PAGES

    ) {

        const sitemapUrl =
            sitemapQueue.shift();


        if (!sitemapUrl) {
            continue;
        }


        if (
            checkedSitemaps.has(
                sitemapUrl
            )
        ) {

            continue;

        }


        checkedSitemaps.add(
            sitemapUrl
        );


        try {

            const response =
                await fetchWithTimeout(
                    sitemapUrl,
                    {
                        headers: {

                            "User-Agent":
                                "ReportliBot/1.0",

                            "Accept":
                                "application/xml,text/xml,text/plain"

                        }
                    },
                    FETCH_TIMEOUT
                );


            if (!response.ok) {

                sitemapErrors++;

                continue;

            }


            const xml =
                await response.text();


            const parsed =
                parseSitemap(
                    xml
                );


            // ------------------------------------------------
            // Nested sitemap files.
            // ------------------------------------------------

            for (
                const nested
                of parsed.sitemaps
            ) {

                if (
                    !checkedSitemaps.has(
                        nested
                    ) &&
                    checkedSitemaps.size +
                    sitemapQueue.length <
                    MAX_SITEMAPS
                ) {

                    sitemapQueue.push(
                        nested
                    );

                }

            }


            // ------------------------------------------------
            // Page URLs.
            // ------------------------------------------------

            for (
                const pageUrl
                of parsed.urls
            ) {

                if (
                    discoveredPages.size >=
                    MAX_PAGES
                ) {

                    break;

                }


                const normalized =
                    normalizePageUrl(
                        pageUrl,
                        origin
                    );


                if (!normalized) {
                    continue;
                }


                // Only same-domain pages.
                if (
                    new URL(
                        normalized
                    ).origin !== origin
                ) {

                    continue;

                }


                discoveredPages.add(
                    normalized
                );

            }

        } catch (error) {

            sitemapErrors++;

            console.log(
                "Sitemap error:",
                sitemapUrl,
                error?.message
            );

        }

    }


    return {

        urls:
            Array.from(
                discoveredPages
            ),

        source,

        sitemapsChecked:
            checkedSitemaps.size,

        sitemapErrors

    };

}


// ============================================================
// PARSE SITEMAP
// ============================================================

function parseSitemap(
    xml
) {

    const sitemaps =
        [];


    const urls =
        [];


    const regex =
        /<loc[^>]*>\s*([\s\S]*?)\s*<\/loc>/gi;


    let match;


    while (
        (match =
            regex.exec(xml))
        !== null
    ) {

        const value =
            decodeXmlEntities(
                match[1].trim()
            );


        if (!value) {
            continue;
        }


        // ----------------------------------------------------
        // Detect nested sitemap.
        // ----------------------------------------------------

        if (
            value.endsWith(".xml") ||
            value.includes("sitemap")
        ) {

            sitemaps.push(
                value
            );

        } else {

            urls.push(
                value
            );

        }

    }


    return {

        sitemaps:
            uniqueUrls(
                sitemaps
            ),

        urls:
            uniqueUrls(
                urls
            )

    };

}


// ============================================================
// ROBOTS SITEMAPS
// ============================================================

function extractSitemapsFromRobots(
    robotsText
) {

    const result =
        [];


    const lines =
        String(
            robotsText || ""
        ).split(
            /\r?\n/
        );


    for (
        const line
        of lines
    ) {

        const clean =
            line.trim();


        if (
            clean
                .toLowerCase()
                .startsWith(
                    "sitemap:"
                )
        ) {

            const sitemap =
                clean
                    .substring(
                        "sitemap:".length
                    )
                    .trim();


            if (sitemap) {

                result.push(
                    sitemap
                );

            }

        }

    }


    return uniqueUrls(
        result
    );

}


// ============================================================
// FETCH PAGE
// ============================================================

async function fetchPage(
    url
) {

    try {

        const response =
            await fetchWithTimeout(

                url,

                {

                    method:
                        "GET",

                    redirect:
                        "follow",

                    headers: {

                        "User-Agent":
                            "Mozilla/5.0 (compatible; ReportliBot/1.0; +https://reportliai.sbs)",

                        "Accept":
                            "text/html,application/xhtml+xml"

                    }

                },

                FETCH_TIMEOUT
            );


        if (!response.ok) {

            return {

                ok:
                    false,

                error:
                    `HTTP ${response.status}`

            };

        }


        const contentType =
            response.headers.get(
                "content-type"
            ) || "";


        if (
            !contentType.includes(
                "text/html"
            ) &&
            !contentType.includes(
                "application/xhtml+xml"
            )
        ) {

            return {

                ok:
                    false,

                error:
                    `Not an HTML page: ${contentType}`

            };

        }


        // ----------------------------------------------------
        // Check declared size.
        // ----------------------------------------------------

        const contentLength =
            Number(
                response.headers.get(
                    "content-length"
                ) || 0
            );


        if (
            contentLength >
            MAX_HTML_BYTES
        ) {

            return {

                ok:
                    false,

                error:
                    "HTML page is larger than 5 MB."

            };

        }


        const html =
            await response.text();


        // ----------------------------------------------------
        // Check actual size.
        // ----------------------------------------------------

        const actualBytes =
            new TextEncoder()
                .encode(
                    html
                )
                .length;


        if (
            actualBytes >
            MAX_HTML_BYTES
        ) {

            return {

                ok:
                    false,

                error:
                    "HTML page is larger than 5 MB."

            };

        }


        return {

            ok:
                true,

            html

        };


    } catch (error) {

        return {

            ok:
                false,

            error:
                error?.message ||
                String(error)

        };

    }

}


// ============================================================
// EXTRACT PAGE TEXT
// ============================================================

function extractPageText(
    html,
    pageUrl
) {

    let working =
        String(
            html || ""
        );


    // --------------------------------------------------------
    // Remove scripts.
    // --------------------------------------------------------

    working =
        working.replace(
            /<script\b[^>]*>[\s\S]*?<\/script>/gi,
            " "
        );


    // --------------------------------------------------------
    // Remove styles.
    // --------------------------------------------------------

    working =
        working.replace(
            /<style\b[^>]*>[\s\S]*?<\/style>/gi,
            " "
        );


    // --------------------------------------------------------
    // Remove noscript.
    // --------------------------------------------------------

    working =
        working.replace(
            /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,
            " "
        );


    // --------------------------------------------------------
    // Remove SVG.
    // --------------------------------------------------------

    working =
        working.replace(
            /<svg\b[^>]*>[\s\S]*?<\/svg>/gi,
            " "
        );


    // --------------------------------------------------------
    // Remove template.
    // --------------------------------------------------------

    working =
        working.replace(
            /<template\b[^>]*>[\s\S]*?<\/template>/gi,
            " "
        );


    // ========================================================
    // TITLE
    // ========================================================

    let title =
        "";


    const titleMatch =
        working.match(
            /<title\b[^>]*>([\s\S]*?)<\/title>/i
        );


    if (titleMatch) {

        title =
            cleanText(
                decodeHtml(
                    stripTags(
                        titleMatch[1]
                    )
                )
            );

    }


    // ========================================================
    // HEADINGS
    // ========================================================

    const headings =
        [];


    const headingRegex =
        /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi;


    let headingMatch;


    while (
        (headingMatch =
            headingRegex.exec(
                working
            ))
        !== null
    ) {

        const heading =
            cleanText(
                decodeHtml(
                    stripTags(
                        headingMatch[1]
                    )
                )
            );


        if (heading) {

            headings.push(
                heading
            );

        }

    }


    // ========================================================
    // ADD NEWLINES AROUND CONTENT BLOCKS
    // ========================================================

    working =
        working.replace(

            /<(br|\/p|\/div|\/section|\/article|\/main|\/header|\/footer|\/li|\/h[1-6]|\/tr|\/td|\/th)[^>]*>/gi,

            "\n"

        );


    // ========================================================
    // REMOVE REMAINING HTML
    // ========================================================

    working =
        stripTags(
            working
        );


    // ========================================================
    // DECODE ENTITIES
    // ========================================================

    working =
        decodeHtml(
            working
        );


    // ========================================================
    // CLEAN TEXT
    // ========================================================

    const text =
        cleanText(
            working
        ).slice(
            0,
            MAX_PAGE_TEXT_CHARS
        );


    return {

        url:
            pageUrl,

        title,

        text,

        headings:
            uniqueStrings(
                headings
            )

    };

}


// ============================================================
// STRIP HTML TAGS
// ============================================================

function stripTags(
    value
) {

    return String(
        value || ""
    ).replace(
        /<[^>]+>/g,
        " "
    );

}


// ============================================================
// CLEAN TEXT
// ============================================================

function cleanText(
    value
) {

    return String(
        value || ""
    )

        .replace(
            /\u00a0/g,
            " "
        )

        .replace(
            /[\t\r\f]+/g,
            " "
        )

        .replace(
            /[ ]{2,}/g,
            " "
        )

        .replace(
            /\n[ ]+/g,
            "\n"
        )

        .replace(
            /[ ]+\n/g,
            "\n"
        )

        .replace(
            /\n{3,}/g,
            "\n\n"
        )

        .trim();

}


// ============================================================
// HTML ENTITY DECODER
// ============================================================

function decodeHtml(
    value
) {

    return String(
        value || ""
    )

        .replace(
            /&nbsp;/gi,
            " "
        )

        .replace(
            /&amp;/gi,
            "&"
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
            /&apos;/gi,
            "'"
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
            /&#(\d+);/g,
            (_, code) =>
                String.fromCodePoint(
                    Number(code)
                )
        )

        .replace(
            /&#x([0-9a-f]+);/gi,
            (_, code) =>
                String.fromCodePoint(
                    parseInt(
                        code,
                        16
                    )
                )
        );

}


// ============================================================
// XML ENTITY DECODER
// ============================================================

function decodeXmlEntities(
    value
) {

    return String(
        value || ""
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
            /&apos;/gi,
            "'"
        );

}


// ============================================================
// NORMALIZE DOMAIN
// ============================================================

function normalizeDomain(
    domain
) {

    if (!domain) {
        return null;
    }


    try {

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
            new URL(
                value
            );


        return url.origin;


    } catch {

        return null;

    }

}


// ============================================================
// NORMALIZE PAGE URL
// ============================================================

function normalizePageUrl(
    value,
    origin
) {

    try {

        const url =
            new URL(
                value,
                origin
            );


        if (
            url.protocol !== "http:" &&
            url.protocol !== "https:"
        ) {

            return null;

        }


        if (
            url.origin !== origin
        ) {

            return null;

        }


        // ----------------------------------------------------
        // Remove #section
        // ----------------------------------------------------

        url.hash =
            "";


        // ----------------------------------------------------
        // Remove common tracking parameters.
        // ----------------------------------------------------

        const tracking =
            [

                "utm_source",
                "utm_medium",
                "utm_campaign",
                "utm_term",
                "utm_content",
                "fbclid",
                "gclid"

            ];


        for (
            const parameter
            of tracking
        ) {

            url.searchParams.delete(
                parameter
            );

        }


        return url.toString();


    } catch {

        return null;

    }

}


// ============================================================
// UNIQUE URLS
// ============================================================

function uniqueUrls(
    urls
) {

    const set =
        new Set();


    for (
        const url
        of urls || []
    ) {

        if (!url) {
            continue;
        }


        set.add(
            String(
                url
            ).trim()
        );

    }


    return Array.from(
        set
    );

}


// ============================================================
// UNIQUE STRINGS
// ============================================================

function uniqueStrings(
    values
) {

    const set =
        new Set();


    for (
        const value
        of values || []
    ) {

        const clean =
            String(
                value || ""
            ).trim();


        if (clean) {

            set.add(
                clean
            );

        }

    }


    return Array.from(
        set
    );

}


// ============================================================
// SUPABASE REQUEST
// ============================================================

async function supabaseRequest(
    env,
    path,
    options = {}
) {

    const baseUrl =
        String(
            env.SUPABASE_URL || ""
        ).replace(
            /\/$/,
            ""
        );


    const serviceKey =
        env.SUPABASE_SERVICE_ROLE_KEY;


    if (!baseUrl) {

        throw new Error(
            "SUPABASE_URL is missing."
        );

    }


    if (!serviceKey) {

        throw new Error(
            "SUPABASE_SERVICE_ROLE_KEY is missing."
        );

    }


    const headers = {

        "apikey":
            serviceKey,

        "Authorization":
            `Bearer ${serviceKey}`,

        "Content-Type":
            "application/json",

        ...(options.headers || {})

    };


    const response =
        await fetch(
            `${baseUrl}${path}`,
            {
                ...options,
                headers
            }
        );


    const text =
        await response.text();


    let data =
        null;


    try {

        data =
            text
                ? JSON.parse(
                    text
                )
                : null;

    } catch {

        data =
            text;

    }


    return {

        ok:
            response.ok,

        status:
            response.status,

        data,

        text

    };

}


// ============================================================
// UPDATE SCRAPE URL
// ============================================================

async function updateScrapeUrl(
    env,
    scrapeUrlId,
    data
) {

    const result =
        await supabaseRequest(

            env,

            `/rest/v1/scrape_urls?id=eq.${encodeURIComponent(scrapeUrlId)}`,

            {
                method:
                    "PATCH",

                headers: {

                    "Prefer":
                        "return=minimal"

                },

                body:
                    JSON.stringify(
                        data
                    )

            }

        );


    if (!result.ok) {

        throw new Error(
            `Could not update scrape URL: ${result.text}`
        );

    }

}


// ============================================================
// UPDATE JOB COUNTERS
// ============================================================

async function updateJobCounters(
    env,
    jobId
) {

    // --------------------------------------------------------
    // Count completed pages using Supabase count header.
    // --------------------------------------------------------

    const completed =
        await supabaseRequest(

            env,

            `/rest/v1/scrape_urls?job_id=eq.${encodeURIComponent(jobId)}&status=eq.completed&select=id`,

            {
                method:
                    "GET",

                headers: {

                    "Prefer":
                        "count=exact"

                }

            }

        );


    // --------------------------------------------------------
    // Count failed pages.
    // --------------------------------------------------------

    const failed =
        await supabaseRequest(

            env,

            `/rest/v1/scrape_urls?job_id=eq.${encodeURIComponent(jobId)}&status=eq.failed&select=id`,

            {
                method:
                    "GET",

                headers: {

                    "Prefer":
                        "count=exact"

                }

            }

        );


    if (!completed.ok) {

        throw new Error(
            `Could not count completed pages: ${completed.text}`
        );

    }


    if (!failed.ok) {

        throw new Error(
            `Could not count failed pages: ${failed.text}`
        );

    }


    const processedCount =
        extractContentRangeCount(
            completed
        );


    const failedCount =
        extractContentRangeCount(
            failed
        );


    // --------------------------------------------------------
    // Update job.
    // --------------------------------------------------------

    const update =
        await supabaseRequest(

            env,

            `/rest/v1/scrape_jobs?id=eq.${encodeURIComponent(jobId)}`,

            {
                method:
                    "PATCH",

                headers: {

                    "Prefer":
                        "return=minimal"

                },

                body:
                    JSON.stringify({

                        processed_urls:
                            processedCount,

                        failed_urls:
                            failedCount,

                        updated_at:
                            new Date().toISOString()

                    })

            }

        );


    if (!update.ok) {

        throw new Error(
            `Could not update job counters: ${update.text}`
        );

    }

}


// ============================================================
// EXTRACT SUPABASE COUNT
// ============================================================

function extractContentRangeCount(
    result
) {

    // Supabase/PostgREST normally returns:
    //
    // Content-Range: 0-0/123
    //
    // We cannot access the response headers because our helper
    // currently returns only the response body.
    //
    // Therefore we use the returned array length for now.
    //
    // This is safe for the small status requests but is not
    // ideal for very large sites.
    //
    // The actual page processing itself does NOT depend on this.
    //

    if (
        Array.isArray(
            result.data
        )
    ) {

        return result.data.length;

    }


    return 0;

}


// ============================================================
// GET JOB
// ============================================================

async function getJob(
    env,
    jobId
) {

    const result =
        await supabaseRequest(

            env,

            `/rest/v1/scrape_jobs?id=eq.${encodeURIComponent(jobId)}&select=*`,

            {
                method:
                    "GET"
            }

        );


    if (!result.ok) {

        throw new Error(
            `Could not get job: ${result.text}`
        );

    }


    return result.data?.[0] ||
        null;

}


// ============================================================
// CHECK JOB COMPLETION
// ============================================================

async function markJobCompletedIfNecessary(
    env,
    jobId
) {

    const job =
        await getJob(
            env,
            jobId
        );


    if (!job) {
        return;
    }


    const processed =
        Number(
            job.processed_urls ||
            0
        );


    const failed =
        Number(
            job.failed_urls ||
            0
        );


    const total =
        Number(
            job.total_urls ||
            0
        );


    if (
        total > 0 &&
        processed + failed >= total
    ) {

        await supabaseRequest(

            env,

            `/rest/v1/scrape_jobs?id=eq.${encodeURIComponent(jobId)}`,

            {
                method:
                    "PATCH",

                headers: {

                    "Prefer":
                        "return=minimal"

                },

                body:
                    JSON.stringify({

                        status:
                            "completed",

                        completed_at:
                            new Date().toISOString(),

                        updated_at:
                            new Date().toISOString()

                    })

            }

        );

    }

}


// ============================================================
// FETCH WITH TIMEOUT
// ============================================================

async function fetchWithTimeout(
    url,
    options,
    timeout
) {

    const controller =
        new AbortController();


    const timer =
        setTimeout(
            () => {
                controller.abort();
            },
            timeout
        );


    try {

        return await fetch(

            url,

            {
                ...options,

                signal:
                    controller.signal
            }

        );

    } finally {

        clearTimeout(
            timer
        );

    }

}


// ============================================================
// CHUNK ARRAY
// ============================================================

function chunkArray(
    array,
    size
) {

    const result =
        [];


    for (
        let i = 0;
        i < array.length;
        i += size
    ) {

        result.push(
            array.slice(
                i,
                i + size
            )
        );

    }


    return result;

}


// ============================================================
// JSON RESPONSE
// ============================================================

function jsonResponse(
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
// CORS
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
