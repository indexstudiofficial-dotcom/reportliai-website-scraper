// ============================================================
// WEBSITE BUSINESS KNOWLEDGE EXTRACTOR
// Cloudflare Worker + Supabase + Sarvam 105B
//
// ENVIRONMENT VARIABLES:
// SUPABASE_URL
// SUPABASE_SECRET_KEY
// SARVAM_API_KEY
//
// INPUT:
//
// {
//   "application_id": "app-123",
//   "domain": "https://example.com",
//   "max_pages": 10,
//   "page_offset": 0
// }
//
// The Worker:
// 1. Finds internal website pages
// 2. Downloads each page
// 3. Removes useless HTML
// 4. Extracts readable content
// 5. Sends content to Sarvam 105B
// 6. Sarvam identifies meaningful fields automatically
// 7. Worker validates the response
// 8. Worker saves fields to business_data
// 9. Returns page_offset for the next batch
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  // Maximum pages processed in one invocation by default.
  // 10 is safer for Cloudflare Free because every page
  // can require multiple external requests.
  DEFAULT_MAX_PAGES: 10,

  // Hard safety maximum supplied by the user.
  MAX_ALLOWED_PAGES: 40,

  // Maximum HTML downloaded from one webpage.
  MAX_HTML_BYTES: 2_000_000,

  // Maximum text sent to Sarvam in one extraction request.
  MAX_CHUNK_CHARS: 30_000,

  // Maximum number of chunks allowed from one page.
  MAX_CHUNKS_PER_PAGE: 8,

  // Maximum sitemap files we follow.
  MAX_SITEMAPS: 20,

  // Maximum URLs collected from sitemaps.
  MAX_DISCOVERED_URLS: 500,

  // Request timeout.
  FETCH_TIMEOUT_MS: 15_000,

  // Sarvam endpoint.
  SARVAM_URL: "https://api.sarvam.ai/v1/chat/completions",

  // Sarvam model.
  SARVAM_MODEL: "sarvam-105b"
};


// ============================================================
// MAIN WORKER
// ============================================================

export default {
  async fetch(request, env, ctx) {
    // --------------------------------------------------------
    // CORS
    // --------------------------------------------------------

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    // --------------------------------------------------------
    // Only POST is supported
    // --------------------------------------------------------

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
      // ------------------------------------------------------
      // Validate environment variables
      // ------------------------------------------------------

      if (!env.SUPABASE_URL) {
        throw new Error("SUPABASE_URL secret is missing.");
      }

      if (!env.SUPABASE_SECRET_KEY) {
        throw new Error("SUPABASE_SECRET_KEY secret is missing.");
      }

      if (!env.SARVAM_API_KEY) {
        throw new Error("SARVAM_API_KEY secret is missing.");
      }

      // ------------------------------------------------------
      // Parse request
      // ------------------------------------------------------

      const body = await request.json();

      const applicationId =
        body.application_id ||
        body.applicationId;

      const websiteUrl =
        body.domain ||
        body.website_url ||
        body.websiteUrl;

      if (!applicationId) {
        return jsonResponse(
          {
            success: false,
            error: "application_id is required."
          },
          400
        );
      }

      if (!websiteUrl) {
        return jsonResponse(
          {
            success: false,
            error: "domain or website_url is required."
          },
          400
        );
      }

      // ------------------------------------------------------
      // Page batch settings
      // ------------------------------------------------------

      let maxPages =
        Number(body.max_pages) ||
        CONFIG.DEFAULT_MAX_PAGES;

      maxPages = Math.max(
        1,
        Math.min(maxPages, CONFIG.MAX_ALLOWED_PAGES)
      );

      let pageOffset =
        Number(body.page_offset) || 0;

      pageOffset = Math.max(0, pageOffset);

      // ------------------------------------------------------
      // Normalize website
      // ------------------------------------------------------

      const baseUrl = normalizeWebsiteUrl(websiteUrl);

      // ------------------------------------------------------
      // Verify application belongs to a user/application
      // ------------------------------------------------------

      const application = await getApplication(
        env,
        applicationId
      );

      if (!application) {
        return jsonResponse(
          {
            success: false,
            error: "Application not found."
          },
          404
        );
      }

      // ------------------------------------------------------
      // Discover website pages
      // ------------------------------------------------------

      const discovered = await discoverWebsitePages(
        baseUrl
      );

      const allPages = discovered.urls;

      // ------------------------------------------------------
      // Select current batch
      // ------------------------------------------------------

      const pages = allPages.slice(
        pageOffset,
        pageOffset + maxPages
      );

      // ------------------------------------------------------
      // Processing statistics
      // ------------------------------------------------------

      const stats = {
        pages_discovered: allPages.length,
        pages_selected: pages.length,
        pages_processed: 0,
        pages_failed: 0,
        chunks_processed: 0,
        fields_extracted: 0,
        fields_saved: 0,
        fields_failed: 0
      };

      const pageResults = [];

      // ------------------------------------------------------
      // Process pages sequentially
      //
      // Sequential processing is intentional.
      // It prevents a large number of simultaneous
      // website/Sarvam/Supabase requests.
      // ------------------------------------------------------

      for (const pageUrl of pages) {
        try {
          const result = await processPage(
            env,
            applicationId,
            pageUrl
          );

          stats.pages_processed++;

          stats.chunks_processed +=
            result.chunks_processed;

          stats.fields_extracted +=
            result.fields_extracted;

          stats.fields_saved +=
            result.fields_saved;

          stats.fields_failed +=
            result.fields_failed;

          pageResults.push({
            url: pageUrl,
            success: true,
            ...result
          });

        } catch (error) {
          stats.pages_failed++;

          pageResults.push({
            url: pageUrl,
            success: false,
            error: error.message
          });
        }
      }

      // ------------------------------------------------------
      // Calculate next batch
      // ------------------------------------------------------

      const nextOffset =
        pageOffset + pages.length;

      const hasMorePages =
        nextOffset < allPages.length;

      // ------------------------------------------------------
      // Response
      // ------------------------------------------------------

      return jsonResponse({
        success: true,

        application_id: applicationId,

        website: baseUrl,

        stats,

        pagination: {
          page_offset: pageOffset,
          next_offset: hasMorePages
            ? nextOffset
            : null,

          has_more_pages: hasMorePages,

          total_pages: allPages.length
        },

        page_results: pageResults,

        message: hasMorePages
          ? `Batch completed. Process the next batch using page_offset=${nextOffset}.`
          : "All discovered pages have been processed."
      });

    } catch (error) {
      console.error(
        "WORKER_ERROR",
        error.message
      );

      return jsonResponse(
        {
          success: false,
          error: error.message
        },
        500
      );
    }
  }
};


// ============================================================
// PROCESS ONE PAGE
// ============================================================

async function processPage(
  env,
  applicationId,
  pageUrl
) {
  // ----------------------------------------------------------
  // Download page
  // ----------------------------------------------------------

  const response = await fetchWithTimeout(
    pageUrl,
    {
      method: "GET",
      headers: {
        "User-Agent":
          "ReportliAI-WebsiteKnowledgeBot/1.0",
        "Accept":
          "text/html,application/xhtml+xml"
      }
    },
    CONFIG.FETCH_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new Error(
      `Website returned HTTP ${response.status}`
    );
  }

  // ----------------------------------------------------------
  // Check content type
  // ----------------------------------------------------------

  const contentType =
    response.headers.get("content-type") || "";

  if (
    !contentType.includes("text/html") &&
    !contentType.includes("application/xhtml+xml")
  ) {
    throw new Error(
      `Not an HTML page. Content-Type: ${contentType}`
    );
  }

  // ----------------------------------------------------------
  // Read HTML
  // ----------------------------------------------------------

  const html = await readLimitedText(
    response,
    CONFIG.MAX_HTML_BYTES
  );

  // ----------------------------------------------------------
  // Clean HTML
  // ----------------------------------------------------------

  const cleaned = extractReadablePage(html);

  if (!cleaned.text.trim()) {
    throw new Error(
      "No readable text found on page."
    );
  }

  // ----------------------------------------------------------
  // Split content into chunks
  // ----------------------------------------------------------

  const chunks = chunkText(
    cleaned.text,
    CONFIG.MAX_CHUNK_CHARS,
    CONFIG.MAX_CHUNKS_PER_PAGE
  );

  // ----------------------------------------------------------
  // Process chunks
  // ----------------------------------------------------------

  let chunksProcessed = 0;
  let fieldsExtracted = 0;
  let fieldsSaved = 0;
  let fieldsFailed = 0;

  for (
    let chunkIndex = 0;
    chunkIndex < chunks.length;
    chunkIndex++
  ) {
    const chunk = chunks[chunkIndex];

    try {
      // ------------------------------------------------------
      // Ask Sarvam to understand the content
      // ------------------------------------------------------

      const extracted =
        await extractWithSarvam(
          env,
          {
            url: pageUrl,
            title: cleaned.title,
            chunkIndex,
            totalChunks: chunks.length,
            content: chunk
          }
        );

      chunksProcessed++;

      if (
        !extracted ||
        !Array.isArray(extracted.fields)
      ) {
        continue;
      }

      // ------------------------------------------------------
      // Validate and normalize AI fields
      // ------------------------------------------------------

      const fields =
        normalizeExtractedFields(
          extracted.fields
        );

      fieldsExtracted += fields.length;

      // ------------------------------------------------------
      // Save fields
      // ------------------------------------------------------

      for (const item of fields) {
        try {
          await saveBusinessData(
            env,
            applicationId,
            item.field,
            item.data,
            pageUrl
          );

          fieldsSaved++;

        } catch (error) {
          fieldsFailed++;

          console.error(
            "FIELD_SAVE_ERROR",
            {
              pageUrl,
              field: item.field,
              error: error.message
            }
          );
        }
      }

    } catch (error) {
      console.error(
        "CHUNK_ERROR",
        {
          pageUrl,
          chunkIndex,
          error: error.message
        }
      );
    }
  }

  return {
    chunks_processed: chunksProcessed,
    fields_extracted: fieldsExtracted,
    fields_saved: fieldsSaved,
    fields_failed: fieldsFailed
  };
}


// ============================================================
// SARVAM EXTRACTION
// ============================================================

async function extractWithSarvam(
  env,
  page
) {
  // ----------------------------------------------------------
  // Strong extraction instructions
  // ----------------------------------------------------------

  const systemPrompt = `
You are a website business knowledge extraction engine.

Your job is to extract EVERY useful factual piece of
information from the supplied website content.

This information will be used by AI employees such as:

- AI receptionist
- WhatsApp agent
- customer support agent
- sales agent
- appointment agent
- Gmail agent

IMPORTANT RULES:

1. Extract information that is actually present.
2. NEVER invent or guess information.
3. Do not omit useful factual information.
4. Create meaningful field names automatically.
5. Field names MUST be lowercase snake_case.
6. Field names must describe the meaning of the data.
7. NEVER use names like:
   section_1
   section_2
   text_1
   unknown
   data_1
8. Prefer useful semantic names such as:
   business_name
   business_description
   services
   pricing
   opening_hours
   appointment_policy
   cancellation_policy
   payment_methods
   address
   phone
   email
   doctors
   staff
   facilities
   qualifications
   insurance
   faq
   products
   product_features
   service_area
   parking_information
   accessibility
   contact_information
   company_history
9. If the information does not fit an existing common category,
   create a new descriptive snake_case field.
10. Preserve important details exactly.
11. Keep arrays as arrays when the content contains lists.
12. Keep objects as objects when the information naturally
    contains multiple properties.
13. Do not create duplicate fields unnecessarily.
14. Combine closely related information when appropriate.
15. Do not extract navigation menu items as business facts.
16. Do not extract cookie banners, privacy popups, CSS,
    JavaScript, tracking code, or unrelated website boilerplate.
17. Do not include your own explanations.
18. Return ONLY the requested JSON structure.
`;

  const userPrompt = `
WEBSITE URL:
${page.url}

PAGE TITLE:
${page.title || ""}

THIS IS CHUNK ${page.chunkIndex + 1}
OF ${page.totalChunks}

WEBSITE CONTENT:
----------------
${page.content}
----------------

Extract all useful factual business knowledge from this
content.

Remember:
- Do not invent anything.
- Use meaningful snake_case field names.
- Preserve the actual information.
- Return only structured fields.
`;

  // ----------------------------------------------------------
  // Structured JSON schema
  // ----------------------------------------------------------

  const responseFormat = {
    type: "json_schema",

    json_schema: {
      name: "business_knowledge",

      strict: true,

      description:
        "Structured business information extracted from website content.",

      schema: {
        type: "object",

        additionalProperties: false,

        properties: {
          fields: {
            type: "array",

            items: {
              type: "object",

              additionalProperties: false,

              properties: {
                field: {
                  type: "string"
                },

                data: {
                  anyOf: [
                    {
                      type: "string"
                    },
                    {
                      type: "number"
                    },
                    {
                      type: "boolean"
                    },
                    {
                      type: "null"
                    },
                    {
                      type: "array",
                      items: {}
                    },
                    {
                      type: "object",
                      additionalProperties: true
                    }
                  ]
                }
              },

              required: [
                "field",
                "data"
              ]
            }
          }
        },

        required: [
          "fields"
        ]
      }
    }
  };

  // ----------------------------------------------------------
  // Sarvam request
  // ----------------------------------------------------------

  const sarvamResponse =
    await fetchWithTimeout(
      CONFIG.SARVAM_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "api-subscription-key":
            env.SARVAM_API_KEY
        },

        body: JSON.stringify({
          model: CONFIG.SARVAM_MODEL,

          messages: [
            {
              role: "system",
              content: systemPrompt
            },
            {
              role: "user",
              content: userPrompt
            }
          ],

          response_format:
            responseFormat,

          temperature: 0.1,

          max_tokens: 4096,

          reasoning_effort: "low"
        })
      },

      60_000
    );

  // ----------------------------------------------------------
  // Read Sarvam response
  // ----------------------------------------------------------

  const responseText =
    await sarvamResponse.text();

  if (!sarvamResponse.ok) {
    throw new Error(
      `Sarvam API error ${sarvamResponse.status}: ${responseText.slice(
        0,
        1000
      )}`
    );
  }

  let responseJson;

  try {
    responseJson =
      JSON.parse(responseText);

  } catch {
    throw new Error(
      "Sarvam returned invalid HTTP JSON."
    );
  }

  const content =
    responseJson
      ?.choices?.[0]
      ?.message
      ?.content;

  if (!content) {
    throw new Error(
      "Sarvam returned no message content."
    );
  }

  // ----------------------------------------------------------
  // Parse structured model JSON
  // ----------------------------------------------------------

  let extracted;

  try {
    extracted =
      typeof content === "string"
        ? JSON.parse(content)
        : content;

  } catch {
    throw new Error(
      "Sarvam returned invalid structured content."
    );
  }

  return extracted;
}


// ============================================================
// NORMALIZE AI FIELDS
// ============================================================

function normalizeExtractedFields(
  fields
) {
  const output = [];
  const used = new Set();

  for (const item of fields) {
    if (!item) continue;

    let field =
      String(item.field || "")
        .trim()
        .toLowerCase();

    if (!field) continue;

    // --------------------------------------------------------
    // Convert spaces/hyphens to underscores
    // --------------------------------------------------------

    field = field
      .replace(/[\s-]+/g, "_")
      .replace(/[^a-z0-9_]/g, "")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");

    if (!field) continue;

    // --------------------------------------------------------
    // Prevent useless field names
    // --------------------------------------------------------

    const badNames = new Set([
      "section",
      "section_1",
      "section_2",
      "text",
      "text_1",
      "text_2",
      "data",
      "data_1",
      "data_2",
      "unknown",
      "information",
      "content",
      "page_content"
    ]);

    if (badNames.has(field)) {
      continue;
    }

    // --------------------------------------------------------
    // Prevent duplicate fields from the same chunk
    // --------------------------------------------------------

    let finalField = field;

    let counter = 2;

    while (used.has(finalField)) {
      finalField =
        `${field}_${counter}`;

      counter++;
    }

    used.add(finalField);

    // --------------------------------------------------------
    // Make sure data exists
    // --------------------------------------------------------

    if (
      item.data === undefined
    ) {
      continue;
    }

    // --------------------------------------------------------
    // Remove empty strings
    // --------------------------------------------------------

    if (
      typeof item.data === "string" &&
      !item.data.trim()
    ) {
      continue;
    }

    // --------------------------------------------------------
    // Avoid absurdly large field values
    // --------------------------------------------------------

    let data = item.data;

    if (
      typeof data === "string" &&
      data.length > 50_000
    ) {
      data =
        data.slice(0, 50_000);
    }

    output.push({
      field: finalField,
      data
    });
  }

  return output;
}


// ============================================================
// SAVE BUSINESS DATA TO SUPABASE
// ============================================================

async function saveBusinessData(
  env,
  applicationId,
  field,
  data,
  sourceUrl
) {
  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data` +
    `?on_conflict=application_id,source_url,field`;

  const response =
    await fetch(url, {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        "apikey":
          env.SUPABASE_SECRET_KEY,

        "Authorization":
          `Bearer ${env.SUPABASE_SECRET_KEY}`,

        "Prefer":
          "resolution=merge-duplicates,return=minimal"
      },

      body: JSON.stringify({
        application_id:
          applicationId,

        field,

        data,

        source_url:
          sourceUrl,

        updated_at:
          new Date().toISOString()
      })
    });

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `Supabase save failed ${response.status}: ${errorText}`
    );
  }
}


// ============================================================
// GET APPLICATION
// ============================================================

async function getApplication(
  env,
  applicationId
) {
  const url =
    `${env.SUPABASE_URL}/rest/v1/applications` +
    `?id=eq.${encodeURIComponent(applicationId)}` +
    `&select=id,user_id,name` +
    `&limit=1`;

  const response =
    await fetch(url, {
      method: "GET",

      headers: {
        "apikey":
          env.SUPABASE_SECRET_KEY,

        "Authorization":
          `Bearer ${env.SUPABASE_SECRET_KEY}`
      }
    });

  if (!response.ok) {
    throw new Error(
      `Could not verify application. HTTP ${response.status}`
    );
  }

  const rows =
    await response.json();

  return rows?.[0] || null;
}


// ============================================================
// WEBSITE PAGE DISCOVERY
// ============================================================

async function discoverWebsitePages(
  baseUrl
) {
  const origin =
    new URL(baseUrl).origin;

  const allowedHost =
    new URL(baseUrl).hostname;

  const urls = new Set();

  // ----------------------------------------------------------
  // Always include homepage
  // ----------------------------------------------------------

  urls.add(
    normalizeUrl(baseUrl)
  );

  // ----------------------------------------------------------
  // Find sitemap locations
  // ----------------------------------------------------------

  const sitemapCandidates =
    new Set([
      `${origin}/sitemap.xml`
    ]);

  // ----------------------------------------------------------
  // robots.txt
  // ----------------------------------------------------------

  try {
    const robotsUrl =
      `${origin}/robots.txt`;

    const robotsResponse =
      await fetchWithTimeout(
        robotsUrl,
        {
          headers: {
            "User-Agent":
              "ReportliAI-WebsiteKnowledgeBot/1.0"
          }
        },
        CONFIG.FETCH_TIMEOUT_MS
      );

    if (robotsResponse.ok) {
      const robots =
        await robotsResponse.text();

      const matches =
        robots.match(
          /Sitemap:\s*(.+)/gi
        );

      if (matches) {
        for (const line of matches) {
          const sitemap =
            line
              .replace(
                /Sitemap:\s*/i,
                ""
              )
              .trim();

          if (isSafeUrl(sitemap)) {
            sitemapCandidates.add(
              sitemap
            );
          }
        }
      }
    }
  } catch {
    // robots.txt is optional
  }

  // ----------------------------------------------------------
  // Process sitemaps
  // ----------------------------------------------------------

  const processedSitemaps =
    new Set();

  const sitemapQueue =
    [...sitemapCandidates];

  while (
    sitemapQueue.length > 0 &&
    processedSitemaps.size <
      CONFIG.MAX_SITEMAPS
  ) {
    const sitemapUrl =
      sitemapQueue.shift();

    if (
      processedSitemaps.has(
        sitemapUrl
      )
    ) {
      continue;
    }

    processedSitemaps.add(
      sitemapUrl
    );

    try {
      const sitemapResponse =
        await fetchWithTimeout(
          sitemapUrl,
          {
            headers: {
              "User-Agent":
                "ReportliAI-WebsiteKnowledgeBot/1.0"
            }
          },
          CONFIG.FETCH_TIMEOUT_MS
        );

      if (!sitemapResponse.ok) {
        continue;
      }

      const xml =
        await readLimitedText(
          sitemapResponse,
          2_000_000
        );

      // ------------------------------------------------------
      // Sitemap index
      // ------------------------------------------------------

      const sitemapLocations =
        extractXmlValues(
          xml,
          "sitemap"
        );

      for (const childSitemap of sitemapLocations) {
        if (
          sitemapQueue.length <
          CONFIG.MAX_SITEMAPS
        ) {
          sitemapQueue.push(
            childSitemap
          );
        }
      }

      // ------------------------------------------------------
      // URL entries
      // ------------------------------------------------------

      const pageLocations =
        extractXmlValues(
          xml,
          "url"
        );

      for (const pageUrl of pageLocations) {
        if (
          urls.size >=
          CONFIG.MAX_DISCOVERED_URLS
        ) {
          break;
        }

        try {
          const parsed =
            new URL(pageUrl);

          if (
            parsed.hostname ===
            allowedHost
          ) {
            urls.add(
              normalizeUrl(pageUrl)
            );
          }
        } catch {
          // ignore invalid URL
        }
      }

    } catch {
      // Ignore bad sitemap
    }
  }

  // ----------------------------------------------------------
  // Also crawl internal links from homepage
  // ----------------------------------------------------------

  try {
    const homepageResponse =
      await fetchWithTimeout(
        baseUrl,
        {
          headers: {
            "User-Agent":
              "ReportliAI-WebsiteKnowledgeBot/1.0"
          }
        },
        CONFIG.FETCH_TIMEOUT_MS
      );

    if (homepageResponse.ok) {
      const html =
        await readLimitedText(
          homepageResponse,
          CONFIG.MAX_HTML_BYTES
        );

      const links =
        extractInternalLinks(
          html,
          origin,
          allowedHost
        );

      for (const link of links) {
        if (
          urls.size >=
          CONFIG.MAX_DISCOVERED_URLS
        ) {
          break;
        }

        urls.add(link);
      }
    }
  } catch {
    // Homepage link discovery is optional
  }

  return {
    urls: [...urls],
    sitemaps_found:
      processedSitemaps.size
  };
}


// ============================================================
// EXTRACT XML VALUES
// ============================================================

function extractXmlValues(
  xml,
  tag
) {
  const values = [];

  const regex =
    new RegExp(
      `<${tag}[^>]*>\\s*<loc[^>]*>([\\s\\S]*?)<\\/loc>\\s*<\\/${tag}>`,
      "gi"
    );

  let match;

  while (
    (match = regex.exec(xml))
  ) {
    const value =
      decodeHtmlEntities(
        match[1].trim()
      );

    if (value) {
      values.push(value);
    }
  }

  return values;
}


// ============================================================
// EXTRACT INTERNAL LINKS
// ============================================================

function extractInternalLinks(
  html,
  origin,
  allowedHost
) {
  const links = new Set();

  const regex =
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;

  let match;

  while (
    (match = regex.exec(html))
  ) {
    const raw =
      decodeHtmlEntities(
        match[1]
      ).trim();

    if (
      !raw ||
      raw.startsWith("#") ||
      raw.startsWith("mailto:") ||
      raw.startsWith("tel:") ||
      raw.startsWith("javascript:")
    ) {
      continue;
    }

    try {
      const url =
        new URL(raw, origin);

      if (
        url.hostname !==
        allowedHost
      ) {
        continue;
      }

      url.hash = "";

      const normalized =
        normalizeUrl(
          url.toString()
        );

      links.add(normalized);

    } catch {
      // Ignore invalid links
    }
  }

  return [...links];
}


// ============================================================
// CLEAN HTML
// ============================================================

function extractReadablePage(
  html
) {
  // ----------------------------------------------------------
  // Remove scripts/styles/etc.
  // ----------------------------------------------------------

  let cleaned =
    html
      .replace(
        /<script\b[^>]*>[\s\S]*?<\/script>/gi,
        " "
      )
      .replace(
        /<style\b[^>]*>[\s\S]*?<\/style>/gi,
        " "
      )
      .replace(
        /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,
        " "
      )
      .replace(
        /<svg\b[^>]*>[\s\S]*?<\/svg>/gi,
        " "
      )
      .replace(
        /<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi,
        " "
      )
      .replace(
        /<canvas\b[^>]*>[\s\S]*?<\/canvas>/gi,
        " "
      );

  // ----------------------------------------------------------
  // Extract title
  // ----------------------------------------------------------

  const titleMatch =
    cleaned.match(
      /<title\b[^>]*>([\s\S]*?)<\/title>/i
    );

  const title =
    titleMatch
      ? cleanText(
          titleMatch[1]
        )
      : "";

  // ----------------------------------------------------------
  // Remove common navigation/boilerplate areas
  // ----------------------------------------------------------

  cleaned =
    cleaned
      .replace(
        /<nav\b[^>]*>[\s\S]*?<\/nav>/gi,
        " "
      )
      .replace(
        /<footer\b[^>]*>[\s\S]*?<\/footer>/gi,
        " "
      )
      .replace(
        /<header\b[^>]*>[\s\S]*?<\/header>/gi,
        " "
      )
      .replace(
        /<aside\b[^>]*>[\s\S]*?<\/aside>/gi,
        " "
      );

  // ----------------------------------------------------------
  // Preserve useful block boundaries
  // ----------------------------------------------------------

  cleaned =
    cleaned
      .replace(
        /<\/(p|div|section|article|main|h1|h2|h3|h4|h5|h6|li|br|tr)>/gi,
        "\n"
      );

  // ----------------------------------------------------------
  // Remove HTML tags
  // ----------------------------------------------------------

  cleaned =
    cleaned.replace(
      /<[^>]+>/g,
      " "
    );

  // ----------------------------------------------------------
  // Decode entities
  // ----------------------------------------------------------

  cleaned =
    decodeHtmlEntities(
      cleaned
    );

  // ----------------------------------------------------------
  // Normalize whitespace
  // ----------------------------------------------------------

  cleaned =
    cleaned
      .replace(
        /\u00a0/g,
        " "
      )
      .replace(
        /[ \t]+/g,
        " "
      )
      .replace(
        /\n\s*\n+/g,
        "\n\n"
      )
      .trim();

  // ----------------------------------------------------------
  // Remove extremely repetitive blank lines
  // ----------------------------------------------------------

  cleaned =
    cleaned
      .split("\n")
      .map(
        line => line.trim()
      )
      .filter(Boolean)
      .join("\n");

  return {
    title,
    text: cleaned
  };
}


// ============================================================
// CHUNK TEXT
// ============================================================

function chunkText(
  text,
  maxChars,
  maxChunks
) {
  if (
    text.length <= maxChars
  ) {
    return [text];
  }

  const chunks = [];

  // ----------------------------------------------------------
  // Prefer paragraph boundaries
  // ----------------------------------------------------------

  const paragraphs =
    text
      .split(/\n{2,}/)
      .map(
        p => p.trim()
      )
      .filter(Boolean);

  let current = "";

  for (const paragraph of paragraphs) {
    if (
      current.length +
        paragraph.length +
        2 <=
      maxChars
    ) {
      current +=
        (current ? "\n\n" : "") +
        paragraph;

    } else {
      if (current) {
        chunks.push(current);
      }

      // ------------------------------------------------------
      // Paragraph itself is too large
      // ------------------------------------------------------

      if (
        paragraph.length >
        maxChars
      ) {
        for (
          let i = 0;
          i < paragraph.length;
          i += maxChars
        ) {
          chunks.push(
            paragraph.slice(
              i,
              i + maxChars
            )
          );

          if (
            chunks.length >=
            maxChunks
          ) {
            return chunks;
          }
        }

        current = "";

      } else {
        current = paragraph;
      }
    }

    if (
      chunks.length >=
      maxChunks
    ) {
      break;
    }
  }

  if (
    current &&
    chunks.length <
      maxChunks
  ) {
    chunks.push(current);
  }

  return chunks.slice(
    0,
    maxChunks
  );
}


// ============================================================
// READ RESPONSE WITH SIZE LIMIT
// ============================================================

async function readLimitedText(
  response,
  maxBytes
) {
  const reader =
    response.body?.getReader();

  if (!reader) {
    const text =
      await response.text();

    if (
      new TextEncoder()
        .encode(text).length >
      maxBytes
    ) {
      throw new Error(
        "Response is too large."
      );
    }

    return text;
  }

  const decoder =
    new TextDecoder();

  let result = "";
  let totalBytes = 0;

  while (true) {
    const {
      done,
      value
    } = await reader.read();

    if (done) {
      break;
    }

    totalBytes +=
      value.byteLength;

    if (
      totalBytes >
      maxBytes
    ) {
      try {
        await reader.cancel();
      } catch {}

      throw new Error(
        "Response exceeded size limit."
      );
    }

    result +=
      decoder.decode(
        value,
        {
          stream: true
        }
      );
  }

  result +=
    decoder.decode();

  return result;
}


// ============================================================
// FETCH WITH TIMEOUT
// ============================================================

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = 15_000
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      timeoutMs
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

  } catch (error) {
    if (
      error.name ===
      "AbortError"
    ) {
      throw new Error(
        `Request timed out after ${timeoutMs}ms: ${url}`
      );
    }

    throw error;

  } finally {
    clearTimeout(timer);
  }
}


// ============================================================
// URL HELPERS
// ============================================================

function normalizeWebsiteUrl(
  input
) {
  let value =
    String(input).trim();

  if (
    !/^https?:\/\//i.test(value)
  ) {
    value =
      "https://" + value;
  }

  const url =
    new URL(value);

  url.hash = "";

  if (
    url.pathname !== "/" &&
    url.pathname.endsWith("/")
  ) {
    url.pathname =
      url.pathname.slice(
        0,
        -1
      );
  }

  return url.toString();
}


function normalizeUrl(
  input
) {
  const url =
    new URL(input);

  url.hash = "";

  // Remove common tracking parameters.
  const trackingPrefixes = [
    "utm_",
    "fbclid",
    "gclid",
    "mc_cid",
    "mc_eid"
  ];

  for (
    const key of [
      ...url.searchParams.keys()
    ]
  ) {
    if (
      trackingPrefixes.some(
        prefix =>
          key === prefix ||
          key.startsWith(prefix)
      )
    ) {
      url.searchParams.delete(
        key
      );
    }
  }

  let result =
    url.toString();

  if (
    url.pathname !== "/" &&
    result.endsWith("/")
  ) {
    result =
      result.slice(
        0,
        -1
      );
  }

  return result;
}


function isSafeUrl(
  input
) {
  try {
    const url =
      new URL(input);

    return (
      url.protocol ===
        "http:" ||
      url.protocol ===
        "https:"
    );

  } catch {
    return false;
  }
}


// ============================================================
// HTML TEXT HELPERS
// ============================================================

function cleanText(
  value
) {
  return decodeHtmlEntities(
    String(value)
      .replace(
        /<[^>]+>/g,
        " "
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim()
  );
}


function decodeHtmlEntities(
  value
) {
  return String(value)
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
      /&#(\d+);/g,
      (_, code) =>
        String.fromCharCode(
          Number(code)
        )
    )
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, code) =>
        String.fromCharCode(
          parseInt(
            code,
            16
          )
        )
    );
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
          "application/json; charset=utf-8",

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
