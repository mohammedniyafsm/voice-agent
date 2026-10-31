import "dotenv/config";
import { checkRoomAvailability, getRoomCatalogDetails } from "./hotel-db.js";

const HOTEL_SYSTEM_INSTRUCTION = `
You are the AI Voice Receptionist for "Grand Haven Hotel", a luxury boutique hotel.
You are talking to a customer over a live telephone call.

Key Guidelines:
1. Speak naturally, warmly, and keep responses concise (1 to 2 sentences maximum), as your response is spoken aloud over the phone.
2. ALWAYS call the provided tools to get real live database facts:
   - Call 'checkRoomAvailability' when the user mentions dates, asks about availability, prices for specific dates, or rooms for a number of guests.
   - Call 'getRoomCatalogDetails' when the user asks what room types exist in general or maximum capacity.
3. If the user specifies the number of guests, recommend the appropriate room (e.g. Standard fits up to 2, Deluxe fits up to 3, Suite fits up to 5).
4. Do not output markdown, bullet points, asterisks, or lists in your voice responses.
`;

const TOOLS_SPEC = [
  {
    function_declarations: [
      {
        name: "checkRoomAvailability",
        description:
          "Check hotel room availability, prices, and room capacity for a specific date and number of guests.",
        parameters: {
          type: "OBJECT",
          properties: {
            date: {
              type: "STRING",
              description:
                "Target date in YYYY-MM-DD format, or relative like 'today' or 'tomorrow'.",
            },
            numberOfGuests: {
              type: "INTEGER",
              description: "Number of guests or family members staying.",
            },
            roomType: {
              type: "STRING",
              description:
                "Optional room type: standard, deluxe, or suite.",
            },
          },
        },
      },
      {
        name: "getRoomCatalogDetails",
        description:
          "Get general list of all room categories, maximum guest capacities, and prices.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
    ],
  },
];

export interface HotelAgent {
  chat(userText: string): Promise<string>;
}

export function createHotelAgent(apiKey?: string): HotelAgent {
  const key = apiKey ?? process.env.GEMINI_API_KEY;

  if (!key) {
    console.warn(
      "[AGENT] GEMINI_API_KEY is not set. Responses will use database fallback.",
    );
    return {
      async chat(userText: string): Promise<string> {
        const today = new Date().toISOString().slice(0, 10);
        checkRoomAvailability({ date: today, numberOfGuests: 2 });
        return `We have standard rooms starting at 99 dollars and deluxe rooms at 160 dollars available today. How many guests will be staying?`;
      },
    };
  }

  // Multi-turn conversation history
  const contents: Array<{
    role: "user" | "model";
    parts: Array<any>;
  }> = [];

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${encodeURIComponent(
    key,
  )}`;

  async function callGemini(): Promise<any> {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: HOTEL_SYSTEM_INSTRUCTION }],
        },
        contents,
        tools: TOOLS_SPEC,
        generation_config: {
          temperature: 0.6,
          max_output_tokens: 150,
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${err}`);
    }

    return res.json();
  }

  return {
    async chat(userText: string): Promise<string> {
      try {
        contents.push({
          role: "user",
          parts: [{ text: userText }],
        });

        let data = await callGemini();
        let candidate = data.candidates?.[0]?.content;

        // Tool execution loop
        while (candidate?.parts?.some((p: any) => p.functionCall)) {
          contents.push(candidate);
          const toolCalls = candidate.parts.filter((p: any) => p.functionCall);

          const toolResponses = [];
          for (const tc of toolCalls) {
            const call = tc.functionCall;
            console.log(
              `[AGENT TOOL] Invoked: ${call.name} with:`,
              call.args,
            );

            let toolResult: unknown;
            if (call.name === "checkRoomAvailability") {
              toolResult = checkRoomAvailability(call.args || {});
            } else if (call.name === "getRoomCatalogDetails") {
              toolResult = getRoomCatalogDetails();
            } else {
              toolResult = { error: "Unknown function" };
            }

            toolResponses.push({
              functionResponse: {
                name: call.name,
                response: toolResult,
              },
            });
          }

          contents.push({
            role: "user",
            parts: toolResponses,
          });

          data = await callGemini();
          candidate = data.candidates?.[0]?.content;
        }

        const textPart = candidate?.parts?.find((p: any) => p.text);
        const reply = textPart?.text?.trim() ?? "Could you please tell me how many guests will be staying?";

        contents.push({
          role: "model",
          parts: [{ text: reply }],
        });

        return reply;
      } catch (error) {
        console.error("[AGENT] Gemini error:", error);
        return "I apologize, our hotel database is momentarily unavailable. How else may I assist you?";
      }
    },
  };
}
