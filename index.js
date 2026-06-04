const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function test() {
    const geminiModel = genAI.getGenerativeModel({
        model: "gemini-2.5-flash"
    });

    const prompt =
        "Answer this question with short answer, as short and simplified as possible, with no extra information as long as the question is answered. Maximum 50 words. Wrap the keywords with asterisk like *this*.\n\nQuestion:\n" +
        "when does magikarp evolve";

    const result = await geminiModel.generateContent({
        contents: [
            {
                role: "user",
                parts: [{ text: prompt }]
            }
        ],
        tools: [{
            googleSearch: {}
        }],
        generationConfig: {
            maxOutputTokens: 100,
            temperature: 0.3
        }
    });

    console.log(result.response.text());
}

test().catch(console.error);
