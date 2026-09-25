// ============================================================
// MRME / REPORTLI WEBSITE SCRAPER
// VERSION: 2026-09-25-V2
// ============================================================

const VERSION = "2026-09-25-V2";

const MAX_SITEMAPS = 30;

// Only process 2 pages per invocation.
// This keeps Cloudflare Worker subrequests low.
const PAGES_PER_PROCESS = 2;

const MAX_PAGES = 5000;

const FETCH_TIMEOUT = 15000;

const MAX_HTML_BYTES = 5 * 1024 * 1024;


// ============================================================
// MAIN WORKER
// ============================================================

export default {
  async fetch(request, env) {

    // ----------------------------------------------------------
    // CORS preflight
    // ----------------------------------------------------------

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders()
      });
    }

    try {

      // --------------------------------------------------------
      // Only POST
      // --------------------------------------------------------

      if (request.method !== "POST") {
        return json({
          success: false,
          error: "Only POST is allowed",
          version: VERSION
        }, 405);
      }

      const body = await request.json();

      const action = body.action;


      // --------------------------------------------------------
      // START
      // --------------------------------------------------------

      if (action === "start") {
        return await startScrape(body, env);
      }


      // --------------------------------------------------------
      // PROCESS
      // --------------------------------------------------------

      if (action === "process") {
        return await processScrape(body, env);
      }


      // --------------------------------------------------------
      // STATUS
      // --------------------------------------------------------

      if (action === "status") {
        return await scrapeStatus(body, env);
      }


      // --------------------------------------------------------
      // Invalid action
      // --------------------------------------------------------

      return json({
        success: false,
        error: "Invalid action. Use start, process, or status.",
        version: VERSION
      }, 400);

    } catch (error) {

      return json({
        success: false,
        version: VERSION,
        error: error?.message || String(error)
      }, 500);
    }
  }
};


// ============================================================
// CORS
// ============================================================

function corsHeaders() {

  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}


// ============================================================
// JSON RESPONSE
// ============================================================

function json(data, status = 200) {

  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    }
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

  const url =
    `${env.SUPABASE_URL}/rest/v1/${path}`;

  const headers = {
    "apikey":
      env.SUPABASE_SERVICE_ROLE_KEY,

    "Authorization":
      `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

    "Content-Type":
      "application/json",

    ...(options.headers || {})
  };


  const response = await fetch(
    url,
    {
      ...options,
      headers
    }
  );


  const text =
    await response.text();


  if (!response.ok) {

    throw new Error(
      `Supabase ${response.status}: ${text}`
    );
  }


  if (!text) {
    return null;
  }


  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}


// ============================================================
// FETCH WITH TIMEOUT
// ============================================================

async function fetchWithTimeout(
  url,
  options = {}
) {

  const controller =
    new AbortController();


  const timeout =
    setTimeout(
      () => controller.abort(),
      FETCH_TIMEOUT
    );


  try {

    return await fetch(
      url,
      {
        ...options,
        signal: controller.signal
      }
    );

  } finally {

    clearTimeout(timeout);
  }
}


// ============================================================
// NORMALIZE DOMAIN
// ============================================================

function normalizeDomain(domain) {

  let value =
    String(domain || "").trim();


  if (!value) {
    throw new Error(
      "domain is required"
    );
  }


  if (
    !/^https?:\/\//i.test(value)
  ) {
    value =
      `https://${value}`;
  }


  const url =
    new URL(value);


  url.pathname = "/";
  url.search = "";
  url.hash = "";


  return url.origin;
}


// ============================================================
// NORMALIZE URL
// ============================================================

function normalizeUrl(
  url,
  baseUrl
) {

  try {

    const parsed =
      new URL(
        url,
        baseUrl
      );


    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      return null;
    }


    // Remove #section
    parsed.hash = "";


    // Remove tracking parameters
    const removeParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid"
    ];


    for (
      const param of removeParams
    ) {

      parsed.searchParams.delete(
        param
      );
    }


    return parsed.href;

  } catch {

    return null;
  }
}


// ============================================================
// SAME ORIGIN
// ============================================================

function isSameOrigin(
  url,
  origin
) {

  try {

    return (
      new URL(url).origin ===
      origin
    );

  } catch {

    return false;
  }
}


// ============================================================
// FETCH TEXT
// ============================================================

async function fetchText(url) {

  const response =
    await fetchWithTimeout(
      url,
      {
        headers: {
          "User-Agent":
            "MRME-Website-Crawler/2.0"
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


  if (
    !contentType.includes("text") &&
    !contentType.includes("xml") &&
    !contentType.includes("html")
  ) {

    throw new Error(
      `Unsupported content type: ${contentType}`
    );
  }


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

    throw new Error(
      "Response too large"
    );
  }


  const text =
    await response.text();


  if (
    text.length >
    MAX_HTML_BYTES
  ) {

    throw new Error(
      "Response too large"
    );
  }


  return text;
}


// ============================================================
// DISCOVER SITEMAPS
// ============================================================

async function discoverSitemaps(
  origin
) {

  const candidates = [

    `${origin}/sitemap.xml`,

    `${origin}/wp-sitemap.xml`,

    `${origin}/sitemap_index.xml`,

    `${origin}/sitemap-index.xml`

  ];


  const discovered =
    new Set();


  // ----------------------------------------------------------
  // robots.txt
  // ----------------------------------------------------------

  try {

    const robots =
      await fetchText(
        `${origin}/robots.txt`
      );


    const lines =
      robots.split(/\r?\n/);


    for (
      const line of lines
    ) {

      if (
        line
          .toLowerCase()
          .startsWith("sitemap:")
      ) {

        const sitemap =
          line
            .substring(
              line.indexOf(":") + 1
            )
            .trim();


        const normalized =
          normalizeUrl(
            sitemap,
            origin
          );


        if (normalized) {
          discovered.add(
            normalized
          );
        }
      }
    }

  } catch {

    // robots.txt is optional
  }


  // ----------------------------------------------------------
  // Standard sitemap locations
  // ----------------------------------------------------------

  for (
    const candidate of candidates
  ) {

    discovered.add(
      candidate
    );
  }


  return [
    ...discovered
  ]
    .filter(
      url =>
        isSameOrigin(
          url,
          origin
        )
    )
    .slice(
      0,
      MAX_SITEMAPS
    );
}


// ============================================================
// PARSE SITEMAP XML
// ============================================================

function parseSitemap(
  xml,
  origin
) {

  const urls =
    new Set();


  const locRegex =
    /<loc[^>]*>([\s\S]*?)<\/loc>/gi;


  let match;


  while (
    (match =
      locRegex.exec(xml))
  ) {

    const raw =
      match[1]
        .replace(
          /<!\[CDATA\[/g,
          ""
        )
        .replace(
          /\]\]>/g,
          ""
        )
        .trim();


    const url =
      normalizeUrl(
        raw,
        origin
      );


    if (url) {
      urls.add(url);
    }
  }


  return [
    ...urls
  ];
}


// ============================================================
// DISCOVER URLS FROM SITEMAPS
// ============================================================

async function discoverUrls(
  origin
) {

  const sitemapUrls =
    await discoverSitemaps(
      origin
    );


  const checked =
    new Set();


  const pageUrls =
    new Set();


  const sitemapQueue =
    [...sitemapUrls];


  let sitemapErrors = 0;


  while (
    sitemapQueue.length > 0 &&
    checked.size < MAX_SITEMAPS
  ) {

    const sitemap =
      sitemapQueue.shift();


    if (
      checked.has(sitemap)
    ) {
      continue;
    }


    checked.add(sitemap);


    try {

      const xml =
        await fetchText(
          sitemap
        );


      const locations =
        parseSitemap(
          xml,
          origin
        );


      for (
        const url of locations
      ) {

        const lower =
          url.toLowerCase();


        const looksLikeSitemap =
          lower.endsWith(".xml") ||
          lower.includes("sitemap");


        // ----------------------------------------------------
        // Nested sitemap
        // ----------------------------------------------------

        if (
          looksLikeSitemap
        ) {

          if (
            !checked.has(url) &&
            sitemapQueue.length <
              MAX_SITEMAPS
          ) {

            sitemapQueue.push(
              url
            );
          }


          continue;
        }


        // ----------------------------------------------------
        // Normal webpage
        // ----------------------------------------------------

        if (
          isSameOrigin(
            url,
            origin
          ) &&
          pageUrls.size <
            MAX_PAGES
        ) {

          pageUrls.add(
            url
          );
        }
      }

    } catch {

      sitemapErrors++;
    }
  }


  return {

    urls:
      [...pageUrls],

    sitemaps_checked:
      checked.size,

    sitemap_errors:
      sitemapErrors
  };
}


// ============================================================
// START SCRAPE
// ============================================================

async function startScrape(
  body,
  env
) {

  const applicationId =
    String(
      body.application_id || ""
    ).trim();


  if (!applicationId) {

    return json({
      success: false,
      error:
        "application_id is required"
    }, 400);
  }


  const origin =
    normalizeDomain(
      body.domain
    );


  // ----------------------------------------------------------
  // Check for existing active job
  // ----------------------------------------------------------

  const existing =
    await supabaseRequest(
      env,
      `scrape_jobs?application_id=eq.${encodeURIComponent(applicationId)}&status=in.(pending,running)&select=*&order=created_at.desc&limit=1`
    );


  if (
    Array.isArray(existing) &&
    existing.length > 0
  ) {

    return json({

      success:
        true,

      message:
        "An active scrape already exists.",

      version:
        VERSION,

      job:
        existing[0]
    });
  }


  // ----------------------------------------------------------
  // Create scrape job
  // ----------------------------------------------------------

  const jobs =
    await supabaseRequest(
      env,
      "scrape_jobs",
      {
        method:
          "POST",

        headers: {
          "Prefer":
            "return=representation"
        },

        body:
          JSON.stringify({

            application_id:
              applicationId,

            website:
              origin,

            status:
              "running"
          })
      }
    );


  const job =
    Array.isArray(jobs)
      ? jobs[0]
      : jobs;


  if (!job?.id) {

    throw new Error(
      "Failed to create scrape job"
    );
  }


  // ----------------------------------------------------------
  // Discover sitemap URLs
  //
  // IMPORTANT:
  // We DO NOT fetch all website pages here.
  // ----------------------------------------------------------

  const discovery =
    await discoverUrls(
      origin
    );


  let urls =
    discovery.urls.slice(
      0,
      MAX_PAGES
    );


  // ----------------------------------------------------------
  // If sitemap is unavailable,
  // start from homepage.
  // ----------------------------------------------------------

  if (
    urls.length === 0
  ) {

    urls = [
      `${origin}/`
    ];
  }


  // ----------------------------------------------------------
  // Create queue records
  // ----------------------------------------------------------

  const queueRows =
    urls.map(
      url => ({

        job_id:
          job.id,

        application_id:
          applicationId,

        url,

        status:
          "pending",

        discovered_from:
          "sitemap"
      })
    );


  // ----------------------------------------------------------
  // ONE bulk Supabase request
  // ----------------------------------------------------------

  await supabaseRequest(
    env,
    "scrape_urls?on_conflict=job_id,url",
    {
      method:
        "POST",

      headers: {
        "Prefer":
          "resolution=ignore-duplicates,return=minimal"
      },

      body:
        JSON.stringify(
          queueRows
        )
    }
  );


  // ----------------------------------------------------------
  // Update total
  // ----------------------------------------------------------

  await supabaseRequest(
    env,
    `scrape_jobs?id=eq.${encodeURIComponent(job.id)}`,
    {
      method:
        "PATCH",

      headers: {
        "Prefer":
          "return=minimal"
      },

      body:
        JSON.stringify({

          total_urls:
            urls.length,

          updated_at:
            new Date().toISOString()
        })
    }
  );


  return json({

    success:
      true,

    version:
      VERSION,

    action:
      "start",

    application_id:
      applicationId,

    website:
      origin,

    job_id:
      job.id,

    discovery: {

      pages_found:
        urls.length,

      sitemaps_checked:
        discovery.sitemaps_checked,

      sitemap_errors:
        discovery.sitemap_errors
    },

    message:
      "Discovery complete. Call action=process using the returned job_id."
  });
}


// ============================================================
// PROCESS SCRAPE QUEUE
// ============================================================

async function processScrape(
  body,
  env
) {

  const jobId =
    String(
      body.job_id || ""
    ).trim();


  if (!jobId) {

    return json({
      success: false,
      error:
        "job_id is required"
    }, 400);
  }


  // ----------------------------------------------------------
  // Get job
  // ----------------------------------------------------------

  const jobs =
    await supabaseRequest(
      env,
      `scrape_jobs?id=eq.${encodeURIComponent(jobId)}&select=*&limit=1`
    );


  if (
    !Array.isArray(jobs) ||
    jobs.length === 0
  ) {

    return json({
      success: false,
      error:
        "Scrape job not found"
    }, 404);
  }


  const job =
    jobs[0];


  // ----------------------------------------------------------
  // Get only 2 pending URLs
  // ----------------------------------------------------------

  const pending =
    await supabaseRequest(
      env,
      `scrape_urls?job_id=eq.${encodeURIComponent(jobId)}&status=eq.pending&select=*&order=created_at.asc&limit=${PAGES_PER_PROCESS}`
    );


  // ----------------------------------------------------------
  // Nothing left
  // ----------------------------------------------------------

  if (
    !Array.isArray(pending) ||
    pending.length === 0
  ) {

    await supabaseRequest(
      env,
      `scrape_jobs?id=eq.${encodeURIComponent(jobId)}`,
      {
        method:
          "PATCH",

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


    return json({

      success:
        true,

      version:
        VERSION,

      action:
        "process",

      job_id:
        jobId,

      message:
        "Scrape completed.",

      done:
        true
    });
  }


  // ----------------------------------------------------------
  // Mark pages as processing
  // ----------------------------------------------------------

  const ids =
    pending.map(
      item => item.id
    );


  await supabaseRequest(
    env,
    `scrape_urls?id=in.(${ids.join(",")})`,
    {
      method:
        "PATCH",

      body:
        JSON.stringify({

          status:
            "processing",

          attempts:
            1
        })
    }
  );


  const results = [];

  let successCount = 0;

  let failedCount = 0;


  // ----------------------------------------------------------
  // Process pages
  // ----------------------------------------------------------

  for (
    const queueItem of pending
  ) {

    try {

      const result =
        await processPage(
          queueItem,
          job,
          env
        );


      successCount++;


      results.push({

        url:
          queueItem.url,

        success:
          true,

        ...result
      });


      // ------------------------------------------------------
      // Mark complete
      // ------------------------------------------------------

      await supabaseRequest(
        env,
        `scrape_urls?id=eq.${queueItem.id}`,
        {
          method:
            "PATCH",

          body:
            JSON.stringify({

              status:
                "completed",

              processed_at:
                new Date().toISOString(),

              error:
                null
            })
        }
      );

    } catch (error) {

      failedCount++;


      const message =
        error?.message ||
        String(error);


      results.push({

        url:
          queueItem.url,

        success:
          false,

        error:
          message
      });


      // ------------------------------------------------------
      // Mark failed
      // ------------------------------------------------------

      await supabaseRequest(
        env,
        `scrape_urls?id=eq.${queueItem.id}`,
        {
          method:
            "PATCH",

          body:
            JSON.stringify({

              status:
                "failed",

              error:
                message,

              processed_at:
                new Date().toISOString()
            })
        }
      );
    }
  }


  // ----------------------------------------------------------
  // Update job counters
  // ----------------------------------------------------------

  await supabaseRequest(
    env,
    `scrape_jobs?id=eq.${encodeURIComponent(jobId)}`,
    {
      method:
        "PATCH",

      body:
        JSON.stringify({

          processed_urls:
            Number(
              job.processed_urls || 0
            ) + successCount,

          failed_urls:
            Number(
              job.failed_urls || 0
            ) + failedCount,

          updated_at:
            new Date().toISOString()
        })
    }
  );


  return json({

    success:
      true,

    version:
      VERSION,

    action:
      "process",

    job_id:
      jobId,

    pages_processed:
      pending.length,

    successful:
      successCount,

    failed:
      failedCount,

    results,

    message:
      "Call action=process again with the same job_id to continue."
  });
}


// ============================================================
// PROCESS ONE PAGE
// ============================================================

async function processPage(
  queueItem,
  job,
  env
) {

  const url =
    queueItem.url;


  // ----------------------------------------------------------
  // Download webpage
  // ----------------------------------------------------------

  const html =
    await fetchText(
      url
    );


  // ----------------------------------------------------------
  // Extract headings + text
  // ----------------------------------------------------------

  const sections =
    extractSections(
      html
    );


  // ----------------------------------------------------------
  // Extract JSON-LD
  // ----------------------------------------------------------

  const jsonLd =
    extractJsonLd(
      html
    );


  // ----------------------------------------------------------
  // Extract internal links
  // ----------------------------------------------------------

  const links =
    extractUsefulLinks(
      html,
      url,
      job.website
    );


  // ----------------------------------------------------------
  // Build database rows
  // ----------------------------------------------------------

  const rows =
    buildBusinessRows({

      applicationId:
        job.application_id,

      sourceUrl:
        url,

      sections,

      jsonLd
    });


  // ----------------------------------------------------------
  // Save data
  // ----------------------------------------------------------

  if (
    rows.length > 0
  ) {

    await saveBusinessData(
      env,
      rows
    );
  }


  // ----------------------------------------------------------
  // Add discovered internal links
  // ----------------------------------------------------------

  if (
    links.length > 0
  ) {

    const queueRows =
      links.map(
        link => ({

          job_id:
            job.id,

          application_id:
            job.application_id,

          url:
            link,

          status:
            "pending",

          discovered_from:
            url
        })
      );


    await supabaseRequest(
      env,
      "scrape_urls?on_conflict=job_id,url",
      {
        method:
          "POST",

        headers: {
          "Prefer":
            "resolution=ignore-duplicates,return=minimal"
        },

        body:
          JSON.stringify(
            queueRows
          )
      }
    );
  }


  return {

    sections_found:
      sections.length,

    json_ld_blocks_found:
      jsonLd.length,

    useful_links_found:
      links.length,

    rows_prepared:
      rows.length,

    rows_saved:
      rows.length
  };
}


// ============================================================
// EXTRACT HEADINGS + TEXT
// ============================================================

function extractSections(
  html
) {

  const sections = [];


  // ----------------------------------------------------------
  // Remove scripts/styles
  // ----------------------------------------------------------

  const clean =
    String(html || "")

      .replace(
        /<script[\s\S]*?<\/script>/gi,
        " "
      )

      .replace(
        /<style[\s\S]*?<\/style>/gi,
        " "
      )

      .replace(
        /<noscript[\s\S]*?<\/noscript>/gi,
        " "
      );


  // ----------------------------------------------------------
  // Find headings
  // ----------------------------------------------------------

  const headingRegex =
    /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi;


  const headings = [];


  let match;


  while (
    (match =
      headingRegex.exec(
        clean
      ))
  ) {

    const level =
      match[1].toLowerCase();


    const heading =
      cleanHtml(
        match[2]
      );


    if (!heading) {
      continue;
    }


    headings.push({

      level,

      heading,

      start:
        match.index,

      end:
        headingRegex.lastIndex
    });
  }


  // ----------------------------------------------------------
  // Get text after each heading
  // until next heading
  // ----------------------------------------------------------

  for (
    let i = 0;
    i < headings.length;
    i++
  ) {

    const current =
      headings[i];


    const next =
      headings[i + 1];


    const rawText =
      clean.substring(

        current.end,

        next
          ? next.start
          : clean.length
      );


    const text =
      cleanHtml(
        rawText
      );


    if (!text) {
      continue;
    }


    sections.push({

      level:
        current.level,

      heading:
        current.heading,

      text:
        limitText(
          text
        )
    });
  }


  return sections;
}


// ============================================================
// EXTRACT JSON-LD
// ============================================================

function extractJsonLd(
  html
) {

  const blocks = [];


  const regex =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;


  let match;


  while (
    (match =
      regex.exec(html))
  ) {

    const raw =
      match[1].trim();


    try {

      blocks.push(
        JSON.parse(raw)
      );

    } catch {

      // Ignore invalid JSON-LD
    }
  }


  return blocks;
}


// ============================================================
// EXTRACT INTERNAL LINKS
// ============================================================

function extractUsefulLinks(
  html,
  pageUrl,
  origin
) {

  const links =
    new Set();


  const regex =
    /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;


  let match;


  while (
    (match =
      regex.exec(html))
  ) {

    const url =
      normalizeUrl(
        match[1],
        pageUrl
      );


    if (!url) {
      continue;
    }


    if (
      !isSameOrigin(
        url,
        origin
      )
    ) {
      continue;
    }


    // --------------------------------------------------------
    // Ignore files
    // --------------------------------------------------------

    if (
      /\.(pdf|jpg|jpeg|png|gif|svg|webp|mp4|mp3|zip|doc|docx|xls|xlsx)(\?|$)/i
        .test(url)
    ) {

      continue;
    }


    links.add(url);


    // Prevent huge queue additions
    if (
      links.size >= 100
    ) {
      break;
    }
  }


  return [
    ...links
  ];
}


// ============================================================
// BUILD BUSINESS DATA ROWS
//
// IMPORTANT:
//
// We deduplicate using:
//
// application_id
// + source_url
// + field
//
// This fixes:
//
// ON CONFLICT DO UPDATE command
// cannot affect row a second time
// ============================================================

function buildBusinessRows({
  applicationId,
  sourceUrl,
  sections,
  jsonLd
}) {

  const rowMap =
    new Map();


  // ----------------------------------------------------------
  // Add row helper
  // ----------------------------------------------------------

  function addRow(
    field,
    data
  ) {

    field =
      cleanField(
        field
      );


    if (!field) {
      return;
    }


    const key =
      `${applicationId}|${sourceUrl}|${field}`;


    // --------------------------------------------------------
    // Duplicate field on same page
    // --------------------------------------------------------

    if (
      rowMap.has(key)
    ) {

      const existing =
        rowMap.get(key);


      const oldData =
        String(
          existing.data ?? ""
        );


      const newData =
        typeof data === "string"
          ? data
          : JSON.stringify(data);


      if (
        newData &&
        !oldData.includes(
          newData
        )
      ) {

        existing.data =
          `${oldData}\n\n${newData}`;
      }


      return;
    }


    // --------------------------------------------------------
    // New row
    // --------------------------------------------------------

    rowMap.set(
      key,
      {

        application_id:
          applicationId,

        field,

        data:
          typeof data === "string"
            ? data
            : JSON.stringify(data),

        source_url:
          sourceUrl,

        updated_at:
          new Date().toISOString()
      }
    );
  }


  // ----------------------------------------------------------
  // Headings
  // ----------------------------------------------------------

  for (
    const section of sections
  ) {

    addRow(
      section.heading,
      section.text
    );
  }


  // ----------------------------------------------------------
  // JSON-LD
  // ----------------------------------------------------------

  for (
    const block of jsonLd
  ) {

    addStructuredData(
      addRow,
      block
    );
  }


  return [
    ...rowMap.values()
  ];
}


// ============================================================
// JSON-LD → STRUCTURED BUSINESS DATA
// ============================================================

function addStructuredData(
  addRow,
  block
) {

  if (
    !block ||
    typeof block !== "object"
  ) {

    return;
  }


  // ----------------------------------------------------------
  // @graph
  // ----------------------------------------------------------

  if (
    Array.isArray(
      block["@graph"]
    )
  ) {

    for (
      const item of block["@graph"]
    ) {

      addStructuredData(
        addRow,
        item
      );
    }
  }


  // ----------------------------------------------------------
  // Business name
  // ----------------------------------------------------------

  if (
    block.name
  ) {

    addRow(
      "structured_business_name",
      block.name
    );
  }


  // ----------------------------------------------------------
  // Description
  // ----------------------------------------------------------

  if (
    block.description
  ) {

    addRow(
      "structured_description",
      block.description
    );
  }


  // ----------------------------------------------------------
  // Phone
  // ----------------------------------------------------------

  if (
    block.telephone
  ) {

    addRow(
      "phone",
      block.telephone
    );
  }


  // ----------------------------------------------------------
  // Email
  // ----------------------------------------------------------

  if (
    block.email
  ) {

    addRow(
      "email",
      block.email
    );
  }


  // ----------------------------------------------------------
  // Price range
  // ----------------------------------------------------------

  if (
    block.priceRange
  ) {

    addRow(
      "price_range",
      block.priceRange
    );
  }


  // ----------------------------------------------------------
  // Address
  // ----------------------------------------------------------

  if (
    block.address
  ) {

    if (
      typeof block.address ===
      "string"
    ) {

      addRow(
        "address",
        block.address
      );

    } else if (
      typeof block.address ===
      "object"
    ) {

      const addressParts =
        [];


      if (
        block.address.streetAddress
      ) {

        addressParts.push(
          block.address.streetAddress
        );
      }


      if (
        block.address.addressLocality
      ) {

        addressParts.push(
          block.address.addressLocality
        );
      }


      if (
        block.address.addressRegion
      ) {

        addressParts.push(
          block.address.addressRegion
        );
      }


      if (
        block.address.postalCode
      ) {

        addressParts.push(
          block.address.postalCode
        );
      }


      if (
        addressParts.length
      ) {

        addRow(
          "address",
          addressParts.join(
            ", "
          )
        );
      }
    }
  }


  // ----------------------------------------------------------
  // Opening hours
  // ----------------------------------------------------------

  if (
    block.openingHours
  ) {

    addRow(
      "opening_hours",
      block.openingHours
    );
  }


  if (
    block.openingHoursSpecification
  ) {

    addRow(
      "opening_hours",
      block.openingHoursSpecification
    );
  }


  // ----------------------------------------------------------
  // Social profiles
  // ----------------------------------------------------------

  if (
    Array.isArray(
      block.sameAs
    )
  ) {

    addRow(
      "social_profiles",
      block.sameAs
    );
  }


  // ----------------------------------------------------------
  // Service type
  // ----------------------------------------------------------

  if (
    block.serviceType
  ) {

    addRow(
      "service_type",
      block.serviceType
    );
  }


  // ----------------------------------------------------------
  // URL
  // ----------------------------------------------------------

  if (
    block.url
  ) {

    addRow(
      "structured_url",
      block.url
    );
  }
}


// ============================================================
// SAVE BUSINESS DATA
// ============================================================

async function saveBusinessData(
  env,
  rows
) {

  if (
    !rows.length
  ) {

    return;
  }


  await supabaseRequest(
    env,
    "business_data?on_conflict=application_id,source_url,field",
    {
      method:
        "POST",

      headers: {

        "Prefer":
          "resolution=merge-duplicates,return=minimal"
      },

      body:
        JSON.stringify(
          rows
        )
    }
  );
}


// ============================================================
// SCRAPE STATUS
// ============================================================

async function scrapeStatus(
  body,
  env
) {

  const jobId =
    String(
      body.job_id || ""
    ).trim();


  if (!jobId) {

    return json({
      success: false,
      error:
        "job_id is required"
    }, 400);
  }


  // ----------------------------------------------------------
  // Get job
  // ----------------------------------------------------------

  const jobs =
    await supabaseRequest(
      env,
      `scrape_jobs?id=eq.${encodeURIComponent(jobId)}&select=*`
    );


  if (
    !Array.isArray(jobs) ||
    jobs.length === 0
  ) {

    return json({
      success: false,
      error:
        "Job not found"
    }, 404);
  }


  const job =
    jobs[0];


  // ----------------------------------------------------------
  // Pending
  // ----------------------------------------------------------

  const pending =
    await supabaseRequest(
      env,
      `scrape_urls?job_id=eq.${encodeURIComponent(jobId)}&status=eq.pending&select=id&limit=5000`
    );


  // ----------------------------------------------------------
  // Processing
  // ----------------------------------------------------------

  const processing =
    await supabaseRequest(
      env,
      `scrape_urls?job_id=eq.${encodeURIComponent(jobId)}&status=eq.processing&select=id&limit=5000`
    );


  return json({

    success:
      true,

    version:
      VERSION,

    job,

    queue: {

      pending:
        Array.isArray(
          pending
        )
          ? pending.length
          : 0,

      processing:
        Array.isArray(
          processing
        )
          ? processing.length
          : 0
    }
  });
}


// ============================================================
// CLEAN HTML
// ============================================================

function cleanHtml(
  html
) {

  return String(
    html || ""
  )

    .replace(
      /<[^>]+>/g,
      " "
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
      /&lt;/gi,
      "<"
    )

    .replace(
      /&gt;/gi,
      ">"
    )

    .replace(
      /\s+/g,
      " "
    )

    .trim();
}


// ============================================================
// CLEAN FIELD
// ============================================================

function cleanField(
  value
) {

  return String(
    value || ""
  )

    .replace(
      /\s+/g,
      " "
    )

    .trim()

    .slice(
      0,
      500
    );
}


// ============================================================
// LIMIT TEXT
// ============================================================

function limitText(
  text
) {

  return String(
    text || ""
  )
    .trim()
    .slice(
      0,
      20000
    );
}
