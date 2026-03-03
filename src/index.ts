#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fetch, { RequestInit, Response } from "node-fetch";

// Variable to store the session token
let sessionCookie: string | null = null;

// Configuration - read from environment variables with defaults
const mediaWikiAPIBase = process.env.MEDIAWIKI_API_BASE || "https://my.mediawiki.instance/api.php";
const wikiBaseAPIBase = process.env.WIKIBASE_API_BASE || "https://my.wikibase.instance/api.php";
const botUsername = process.env.MEDIAWIKI_BOT_USERNAME || "";
const botPassword = process.env.MEDIAWIKI_BOT_PASSWORD || "";

const USER_AGENT = "mediawikiadapter-app/1.0";

// Create server instance
const server = new McpServer({
  name: "mediawikiadapter",
  version: "1.0.0",
});

// Function to log in as a bot
async function loginAsBot(username: string, password: string): Promise<void> {
  const loginUrl = `${mediaWikiAPIBase}?action=login&format=json`;

  // Step 1: Get login token
  const tokenResponse = await fetch(`${mediaWikiAPIBase}?action=query&meta=tokens&type=login&format=json`, {
    headers: {
      "User-Agent": USER_AGENT,
    },
  });

  if (!tokenResponse.ok) {
    throw new Error(`Failed to fetch login token: ${tokenResponse.statusText}`);
  }

  // Save the cookie from token response for the login request
  const tokenCookie = tokenResponse.headers.get("set-cookie");

  const tokenData = await tokenResponse.json() as { query?: { tokens?: { logintoken?: string } } };
  const loginToken = tokenData.query?.tokens?.logintoken;

  if (!loginToken) {
    throw new Error("Failed to retrieve login token.");
  }

  // Step 2: Log in with the token (include cookie from token request)
  const loginHeaders: Record<string, string> = {
    "User-Agent": USER_AGENT,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (tokenCookie) {
    loginHeaders["Cookie"] = tokenCookie;
  }

  const loginResponse = await fetch(loginUrl, {
    method: "POST",
    headers: loginHeaders,
    body: new URLSearchParams({
      lgname: username,
      lgpassword: password,
      lgtoken: loginToken,
    }),
  });

  if (!loginResponse.ok) {
    throw new Error(`Failed to log in: ${loginResponse.statusText}`);
  }

  const loginResult = await loginResponse.json() as { login?: { result?: string; reason?: string } };

  if (loginResult.login?.result !== "Success") {
    throw new Error(`Login failed: ${loginResult.login?.reason || "Unknown reason"}`);
  }

  // Store the session cookie (combine both cookies if both exist)
  const loginCookie = loginResponse.headers.get("set-cookie");
  if (tokenCookie && loginCookie) {
    sessionCookie = `${tokenCookie}; ${loginCookie}`;
  } else {
    sessionCookie = loginCookie || tokenCookie;
  }
  console.log("Bot logged in successfully.");
}

// Update fetch calls to include the session cookie if available
async function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const headers = { ...options.headers } as Record<string, string>;
  if (sessionCookie) {
    headers["Cookie"] = sessionCookie;
  }
  const response = await fetch(url, { ...options, headers });
  return response;
}

function handleError(error: unknown): never {
  if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
    throw new Error(error.message);
  } else {
    console.error(`Unknown error: ${JSON.stringify(error)}`);
    throw new Error("An unknown error occurred.");
  }
}

// Define types for API responses
interface PageQueryResult {
  query?: {
    pages?: Record<string, {
      pageid?: number;
      title?: string;
      revisions?: Array<{ "*": string }>;
      touched?: string;
      contributors?: Array<{ name: string }>;
    }>;
    search?: Array<{ title: string}>;
    tokens?: {
      logintoken?: string;
      csrftoken?: string;
    };
  };
}

interface EntityQueryResult {
  entities?: Record<string, {
    id?: string;
    labels?: Record<string, { value: string }>;
  }>;
  search?: Array<{
    id: string;
    label: string;
  }>;
}

interface EditResult {
  edit?: {
    result?: string;
  };
}

interface DeleteResult {
  delete?: {
    result?: string;
  };
}

interface WbEditResult {
  success?: number;
  entity?: {
    id?: string;
  };
}

interface ClaimResult {
  success?: number;
}

// Register tool: getPageContent
server.tool(
  "getPageContent",
  "Fetches the content of a MediaWiki page",
  {
    title: z.string().describe("The title of the page to fetch"),
  },
  async (args) => {
    try {
      const { title } = args;

      // Construct the API URL
      const url = `${mediaWikiAPIBase}?action=query&format=json&prop=revisions&rvprop=content&titles=${encodeURIComponent(
        title
      )}`;

      // Fetch the page content
      const response = await authenticatedFetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch page content: ${response.statusText}`);
      }

      const data = await response.json() as PageQueryResult;

      // Extract the page content
      const pages = data.query?.pages;
      const page = pages ? Object.values(pages)[0] : null;
      const content = page?.revisions?.[0]?.["*"];

      if (!content) {
        throw new Error(`Page "${title}" not found or has no content.`);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: content,
          },
        ],
      };
    } catch (error) {
      handleError(error);
    }
  }
);

// Register tool: editPage
server.tool(
  "editPage",
  "Edits a MediaWiki page",
  {
    title: z.string().describe("The title of the page to edit"),
    content: z.string().describe("The new content for the page"),
    summary: z.string().optional().describe("Edit summary"),
  },
  async (args) => {
    try {
      const { title, content, summary } = args;

      // Construct the API URL
      const url = `${mediaWikiAPIBase}?action=edit&format=json`;

      // Fetch an edit token (required for editing)
      const tokenResponse = await authenticatedFetch(
        `${mediaWikiAPIBase}?action=query&meta=tokens&format=json`,
        {
          headers: {
            "User-Agent": USER_AGENT,
          },
        }
      );

      if (!tokenResponse.ok) {
        throw new Error(`Failed to fetch edit token: ${tokenResponse.statusText}`);
      }

      const tokenData = await tokenResponse.json() as PageQueryResult;
      const editToken = tokenData.query?.tokens?.csrftoken;

      if (!editToken) {
        throw new Error("Failed to retrieve edit token.");
      }

      // Perform the edit
      const editResponse = await authenticatedFetch(url, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          title,
          text: content,
          summary: summary || "",
          token: editToken,
        }),
      });

      if (!editResponse.ok) {
        throw new Error(`Failed to edit page: ${editResponse.statusText}`);
      }

      const editResult = await editResponse.json() as EditResult;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: editResult.edit?.result === "Success" }),
          },
        ],
      };
    } catch (error) {
      handleError(error);
    }
  }
);

// Register tool: getPageSearchResults
server.tool(
  "getPageSearchResults",
  "Searches for pages matching a query",
  {
    query: z.string().describe("The search query"),
    limit: z.number().optional().describe("Maximum number of results"),
  },
  async (args) => {
    const { query, limit = 10 } = args;

    const url = `${mediaWikiAPIBase}?action=query&list=search&format=json&srsearch=${encodeURIComponent(query)}&srlimit=${limit}`;

    const response = await authenticatedFetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to search pages: ${response.statusText}`);
    }

    const data = await response.json() as PageQueryResult;
    const results = data.query?.search?.map((item) => ({
      title: item.title,
      snippet: item.snippet || "",
    })) || [];

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ results }),
        },
      ],
    };
  }
);

// Register tool: getPageMetadata
server.tool(
  "getPageMetadata",
  "Fetches metadata for a MediaWiki page",
  {
    title: z.string().describe("The title of the page"),
  },
  async (args) => {
    const { title } = args;

    const url = `${mediaWikiAPIBase}?action=query&format=json&prop=info|contributors&titles=${encodeURIComponent(title)}`;

    const response = await authenticatedFetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch page metadata: ${response.statusText}`);
    }

    const data = await response.json() as PageQueryResult;
    const pages = data.query?.pages;
    const page = pages ? Object.values(pages)[0] : null;

    if (!page) {
      throw new Error(`Page "${title}" not found.`);
    }

    const metadata = {
      pageId: page.pageid,
      lastEdited: page.touched,
      contributors: page.contributors?.map((c) => c.name) || [],
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(metadata),
        },
      ],
    };
  }
);

// Register tool: createPage
server.tool(
  "createPage",
  "Creates a new MediaWiki page",
  {
    title: z.string().describe("The title of the new page"),
    content: z.string().describe("The content of the new page"),
    summary: z.string().optional().describe("Edit summary"),
  },
  async (args) => {
    const { title, content, summary } = args;

    const url = `${mediaWikiAPIBase}?action=edit&format=json`;

    const tokenResponse = await authenticatedFetch(
      `${mediaWikiAPIBase}?action=query&meta=tokens&format=json`,
      {
        headers: {
          "User-Agent": USER_AGENT,
        },
      }
    );

    if (!tokenResponse.ok) {
      throw new Error(`Failed to fetch edit token: ${tokenResponse.statusText}`);
    }

    const tokenData = await tokenResponse.json() as PageQueryResult;
    const editToken = tokenData.query?.tokens?.csrftoken;

    if (!editToken) {
      throw new Error("Failed to retrieve edit token.");
    }

    const editResponse = await authenticatedFetch(url, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        title,
        text: content,
        summary: summary || "",
        token: editToken,
        createonly: "true",
      }),
    });

    if (!editResponse.ok) {
      throw new Error(`Failed to create page: ${editResponse.statusText}`);
    }

    const editResult = await editResponse.json() as EditResult;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ success: editResult.edit?.result === "Success" }),
        },
      ],
    };
  }
);

// Register tool: deletePage
server.tool(
  "deletePage",
  "Deletes a MediaWiki page",
  {
    title: z.string().describe("The title of the page to delete"),
    reason: z.string().optional().describe("Reason for deletion"),
  },
  async (args) => {
    const { title, reason } = args;

    const url = `${mediaWikiAPIBase}?action=delete&format=json`;

    const tokenResponse = await authenticatedFetch(
      `${mediaWikiAPIBase}?action=query&meta=tokens&format=json`,
      {
        headers: {
          "User-Agent": USER_AGENT,
        },
      }
    );

    if (!tokenResponse.ok) {
      throw new Error(`Failed to fetch delete token: ${tokenResponse.statusText}`);
    }

    const tokenData = await tokenResponse.json() as PageQueryResult;
    const deleteToken = tokenData.query?.tokens?.csrftoken;

    if (!deleteToken) {
      throw new Error("Failed to retrieve delete token.");
    }

    const deleteResponse = await authenticatedFetch(url, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        title,
        reason: reason || "",
        token: deleteToken,
      }),
    });

    if (!deleteResponse.ok) {
      throw new Error(`Failed to delete page: ${deleteResponse.statusText}`);
    }

    const deleteResult = await deleteResponse.json() as DeleteResult;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ success: deleteResult.delete?.result === "Success" }),
        },
      ],
    };
  }
);

// Register tool: getEntityData
server.tool(
  "getEntityData",
  "Fetches data for a Wikibase entity",
  {
    id: z.string().describe("The ID of the entity (e.g., Q42)"),
  },
  async (args) => {
    const { id } = args;

    const url = `${wikiBaseAPIBase}?action=wbgetentities&format=json&ids=${encodeURIComponent(id)}`;

    const response = await authenticatedFetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch entity data: ${response.statusText}`);
    }

    const data = await response.json() as EntityQueryResult;
    const entity = data.entities?.[id];

    if (!entity) {
      throw new Error(`Entity "${id}" not found.`);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ entity }),
        },
      ],
    };
  }
);

// Register tool: searchEntities
server.tool(
  "searchEntities",
  "Searches for Wikibase entities by label or description",
  {
    search: z.string().describe("The search term"),
    type: z.enum(["item", "property"]).describe("The type of entity to search for"),
    limit: z.number().optional().describe("Maximum number of results"),
  },
  async (args) => {
    const { search, type, limit = 10 } = args;

    const url = `${wikiBaseAPIBase}?action=wbsearchentities&format=json&search=${encodeURIComponent(
      search
    )}&type=${type}&limit=${limit}`;

    const response = await authenticatedFetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to search entities: ${response.statusText}`);
    }

    const data = await response.json() as EntityQueryResult;
    const results = data.search?.map((item) => ({
      id: item.id,
      label: item.label,
    })) || [];

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ results }),
        },
      ],
    };
  }
);

// Register tool: editEntity
server.tool(
  "editEntity",
  "Creates or edits a Wikibase entity",
  {
    id: z.string().optional().describe("The ID of the entity to edit (optional for creation)"),
    data: z.record(z.any()).describe("The JSON representation of the entity data"),
    summary: z.string().optional().describe("Edit summary"),
  },
  async (args) => {
    const { id, data, summary } = args;

    const url = `${wikiBaseAPIBase}?action=wbeditentity&format=json`;

    const tokenResponse = await authenticatedFetch(
      `${wikiBaseAPIBase}?action=query&meta=tokens&format=json&type=csrf`,
      {
        headers: {
          "User-Agent": USER_AGENT,
        },
      }
    );

    if (!tokenResponse.ok) {
      throw new Error(`Failed to fetch edit token: ${tokenResponse.statusText}`);
    }

    const tokenData = await tokenResponse.json() as PageQueryResult;
    const editToken = tokenData.query?.tokens?.csrftoken;

    if (!editToken) {
      throw new Error("Failed to retrieve edit token.");
    }

    const editResponse = await authenticatedFetch(url, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        id: id || "", // Empty for creating a new entity
        data: JSON.stringify(data),
        summary: summary || "",
        token: editToken,
      }),
    });

    if (!editResponse.ok) {
      throw new Error(`Failed to edit entity: ${editResponse.statusText}`);
    }

    const editResult = await editResponse.json() as WbEditResult;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: editResult.success === 1,
            id: editResult.entity?.id,
          }),
        },
      ],
    };
  }
);

// Register tool: addStatement
server.tool(
  "addStatement",
  "Adds a statement to a Wikibase entity",
  {
    id: z.string().describe("The ID of the entity"),
    property: z.string().describe("The property ID"),
    value: z.any().describe("The value of the statement"),
  },
  async (args) => {
    const { id, property, value } = args;

    const url = `${wikiBaseAPIBase}?action=wbcreateclaim&format=json`;

    const tokenResponse = await authenticatedFetch(
      `${wikiBaseAPIBase}?action=query&meta=tokens&format=json&type=csrf`,
      {
        headers: {
          "User-Agent": USER_AGENT,
        },
      }
    );

    if (!tokenResponse.ok) {
      throw new Error(`Failed to fetch claim token: ${tokenResponse.statusText}`);
    }

    const tokenData = await tokenResponse.json() as PageQueryResult;
    const claimToken = tokenData.query?.tokens?.csrftoken;

    if (!claimToken) {
      throw new Error("Failed to retrieve claim token.");
    }

    const claimResponse = await authenticatedFetch(url, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        entity: id,
        property,
        snaktype: "value",
        value: JSON.stringify(value),
        token: claimToken,
      }),
    });

    if (!claimResponse.ok) {
      throw new Error(`Failed to add statement: ${claimResponse.statusText}`);
    }

    const claimResult = await claimResponse.json() as ClaimResult;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ success: claimResult.success === 1 }),
        },
      ],
    };
  }
);

// Start the server
async function main() {
  // Log in as bot at startup
  if (botUsername && botPassword) {
    try {
      await loginAsBot(botUsername, botPassword);
    } catch (error) {
      console.error("Failed to log in as bot:", error);
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MediaWiki MCP Adapter running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
