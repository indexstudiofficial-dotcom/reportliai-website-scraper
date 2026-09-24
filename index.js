export default {
  async fetch(request, env) {
    // ==================================================
    // CORS
    // ==================================================

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders()
      });
    }

    if (request.method !== "POST") {
      return json(
        { error: "Only POST requests are allowed." },
        405
      );
    }

    try {
      // ==================================================
      // 1. READ REQUEST
      // ==================================================

      const body = await request.json();

      const applicationId = body.application_id;
      const websiteUrl = body.website_url;

      if (!applicationId || !websiteUrl) {
        return json(
          {
            error: "application_id and website_url are required."
          },
          400
        );
      }

      // ==================================================
      // 2. VALIDATE APPLICATION
      // ==================================================

      const application = await getApplication(
        applicationId,
        env
      );

      if (!application) {
        return json(
          {
            error: "Application not found."
          },
          404
        );
      }

      // ==================================================
      // 3. VALIDATE WEBSITE URL
      // ==================================================

      let startUrl;

      try {
        startUrl = new URL(websiteUrl);
      } catch {
        return json(
          {
            error: "Invalid website URL."
          },
          400
        );
      }

      if (
        startUrl.protocol !== "https:" &&
        startUrl.protocol !== "http:"
      ) {
        return json(
          {
            error: "Only HTTP and HTTPS websites are allowed."
          },
          400
        );
      }

      // ==================================================
      // 4. DISCOVER WEBSITE PAGES
      // ==================================================

      const pages = await discoverPages(
        startUrl,
        env
      );

      console.log(
        `Found ${pages.length} pages`
      );

      // ==================================================
      // 5. PROCESS EACH PAGE ONE BY ONE
      // ==================================================

      let processed = 0;
      let failed = 0;

      for (const pageUrl of pages) {

        try {

          console.log(
            `Processing: ${pageUrl}`
          );

          // ----------------------------------------------
          // Fetch ONE page
          // ----------------------------------------------

          const page = await scrapePage(
            pageUrl,
            env
          );

          if (!page || !page.text) {
            failed++;
            continue;
          }

          // ----------------------------------------------
          // Send ONLY this page to Sarvam
          // ----------------------------------------------

          const extracted = await extractWithSarvam(
            page,
            env
          );

          // ----------------------------------------------
          // Save this page's information immediately
          // ----------------------------------------------

          await saveBusinessData(
            applicationId,
            extracted,
            pageUrl,
            env
          );

          processed++;

        } catch (error) {

          console.error(
            `Failed page ${pageUrl}:`,
            error
          );

          failed++;
        }
      }

      // ==================================================
      // 6. FINISH
      // ==================================================

      return json({
        success: true,
        application_id: applicationId,
        pages_found: pages.length,
        pages_processed: processed,
        pages_failed: failed
      });

    } catch (error) {

      console.error(error);

      return json(
        {
          error: "Website scraping failed."
        },
        500
      );
    }
  }
};


// ======================================================
// CORS
// ======================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization"
  };
}


// ======================================================
// JSON RESPONSE
// ======================================================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    }
  );
}


// ======================================================
// VERIFY APPLICATION
// ======================================================

async function getApplication(
  applicationId,
  env
) {

  const url =
    `${env.SUPABASE_URL}/rest/v1/applications` +
    `?id=eq.${encodeURIComponent(applicationId)}` +
    `&select=id`;

  const response = await fetch(
    url,
    {
      headers: {
        "apikey": env.SUPABASE_SECRET_KEY,
        "Authorization":
          `Bearer ${env.SUPABASE_SECRET_KEY}`
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      "Could not verify application."
    );
  }

  const rows = await response.json();

  return rows.length > 0
    ? rows[0]
    : null;
}


// ======================================================
// DISCOVER WEBSITE PAGES
// ======================================================

async function discoverPages(
  startUrl,
  env
) {

  const hostname =
    startUrl.hostname;

  const queue = [
    startUrl.toString()
  ];

  const visited = new Set();

  const MAX_PAGES = 200;

  while (
    queue.length > 0 &&
    visited.size < MAX_PAGES
  ) {

    const currentUrl =
      queue.shift();

    if (visited.has(currentUrl)) {
      continue;
    }

    visited.add(currentUrl);

    try {

      const response = await fetch(
        currentUrl,
        {
          method: "GET",
          headers: {
            "User-Agent":
              "YourSaaS Website Crawler"
          },
          redirect: "follow"
        }
      );

      if (!response.ok) {
        continue;
      }

      const contentType =
        response.headers.get(
          "content-type"
        ) || "";

      if (
        !contentType.includes(
          "text/html"
        )
      ) {
        continue;
      }

      const html =
        await response.text();

      const links =
        extractLinks(
          html,
          currentUrl
        );

      for (const link of links) {

        try {

          const parsed =
            new URL(link);

          // Only crawl the same hostname
          if (
            parsed.hostname !== hostname
          ) {
            continue;
          }

          // Only HTTP/HTTPS
          if (
            parsed.protocol !== "http:" &&
            parsed.protocol !== "https:"
          ) {
            continue;
          }

          // Remove fragments
          parsed.hash = "";

          const normalized =
            parsed.toString();

          if (
            !visited.has(normalized) &&
            !queue.includes(normalized) &&
            visited.size + queue.length <
              MAX_PAGES
          ) {

            queue.push(normalized);
          }

        } catch {
          // Ignore invalid links
        }
      }

    } catch (error) {

      console.error(
        `Discovery failed: ${currentUrl}`,
        error
      );
    }
  }

  return Array.from(visited);
}


// ======================================================
// EXTRACT LINKS
// ======================================================

function extractLinks(
  html,
  baseUrl
) {

  const links = [];

  const regex =
    /<a[^>]+href=["']([^"']+)["']/gi;

  let match;

  while (
    (match = regex.exec(html)) !== null
  ) {

    try {

      const absolute =
        new URL(
          match[1],
          baseUrl
        );

      absolute.hash = "";

      links.push(
        absolute.toString()
      );

    } catch {
      // Ignore invalid URLs
    }
  }

  return links;
}


// ======================================================
// SCRAPE ONE PAGE
// ======================================================

async function scrapePage(
  pageUrl,
  env
) {

  const response =
    await fetch(
      pageUrl,
      {
        method: "GET",
        headers: {
          "User-Agent":
            "YourSaaS Website Crawler"
        },
        redirect: "follow"
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
    !contentType.includes(
      "text/html"
    )
  ) {
    return null;
  }

  const html =
    await response.text();

  const title =
    extractTitle(html);

  const text =
    cleanHtml(html);

  return {
    url: pageUrl,
    title,
    text: text.slice(0, 30000)
  };
}


// ======================================================
// EXTRACT TITLE
// ======================================================

function extractTitle(html) {

  const match =
    html.match(
      /<title[^>]*>([\s\S]*?)<\/title>/i
    );

  if (!match) {
    return "";
  }

  return decodeHtml(
    match[1]
  ).trim();
}


// ======================================================
// CLEAN HTML
// ======================================================

function cleanHtml(html) {

  return html
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
    )
    .replace(
      /<[^>]+>/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


// ======================================================
// BASIC HTML DECODER
// ======================================================

function decodeHtml(text) {

  return text
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


// ======================================================
// SEND ONE PAGE TO SARVAM
// ======================================================

async function extractWithSarvam(
  page,
  env
) {

  const prompt = `
You are extracting structured business information
from ONE webpage.

Website URL:
${page.url}

Page title:
${page.title}

Page content:
${page.text}

Extract ONLY information that is actually present
on this webpage.

Do NOT invent information.

Return ONLY valid JSON.

Format:

[
  {
    "field": "business_name",
    "data": "ABC Business"
  },
  {
    "field": "address",
    "data": "..."
  }
]

Possible field names include:

business_name
description
address
phone
email
opening_hours
services
pricing
faq
privacy_policy
refund_policy
cancellation_policy
terms
social_links
contact_information

You may create another useful field if necessary.

If the page contains no useful business information,
return:

[]
`;

  // ----------------------------------------------
  // IMPORTANT:
  // Use your Sarvam API endpoint/model according
  // to the current Sarvam API configuration.
  // ----------------------------------------------

  const response =
    await fetch(
      env.SARVAM_API_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "api-subscription-key":
            env.SARVAM_API_KEY
        },

        body: JSON.stringify({
          model:
            env.SARVAM_MODEL,

          messages: [
            {
              role: "user",
              content: prompt
            }
          ]
        })
      }
    );

  if (!response.ok) {

    const errorText =
      await response.text();

    throw new Error(
      `Sarvam error: ${errorText}`
    );
  }

  const result =
    await response.json();

  // ----------------------------------------------
  // Adjust this depending on the exact Sarvam
  // response format you use.
  // ----------------------------------------------

  const content =
    result.choices?.[0]?.message?.content;

  if (!content) {
    return [];
  }

  return parseAIJson(content);
}


// ======================================================
// PARSE AI JSON
// ======================================================

function parseAIJson(content) {

  try {

    return JSON.parse(content);

  } catch {

    // Sometimes models return:
    //
    // ```json
    // [...]
    // ```

    const cleaned =
      content
        .replace(
          /^```json/i,
          ""
        )
        .replace(
          /^```/i,
          ""
        )
        .replace(
          /```$/i,
          ""
        )
        .trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      throw new Error(
        "Sarvam returned invalid JSON."
      );
    }
  }
}


// ======================================================
// SAVE TO SUPABASE
// ======================================================

async function saveBusinessData(
  applicationId,
  extractedData,
  sourceUrl,
  env
) {

  if (
    !Array.isArray(
      extractedData
    )
  ) {
    return;
  }

  const rows =
    extractedData
      .filter(item =>
        item &&
        typeof item.field === "string" &&
        item.field.trim() !== ""
      )
      .map(item => ({
        application_id:
          applicationId,

        field:
          item.field.trim(),

        data:
          item.data,

        source_url:
          sourceUrl
      }));

  if (rows.length === 0) {
    return;
  }

  const response =
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/business_data` +
      `?on_conflict=application_id,field`,
      {
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

        body:
          JSON.stringify(rows)
      }
    );

  if (!response.ok) {

    const errorText =
      await response.text();

    throw new Error(
      `Supabase error: ${errorText}`
    );
  }
      }
