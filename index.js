const axios = require("axios");

async function test() {

    const response = await axios.post(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
            contents: [
                {
                    parts: [
                        {
                            text: "Hello"
                        }
                    ]
                }
            ]
        },
        {
            headers: {
                "x-goog-api-key": process.env.GEMINI_API_KEY,
                "Content-Type": "application/json"
            }
        }
    );

    console.log(response.data);
}

test().catch(err => {
    console.log(err.response?.data || err);
});
