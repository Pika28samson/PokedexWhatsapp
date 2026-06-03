const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// You will copy these from the Meta Developer Dashboard
const TOKEN = 'EAAOZBMSeaZAGEBRjQ9iUvYktGu2eHm7Btt0q4WTVRDFn4WuR1co5i9GU1KrS0CkuOGGhdOxAfjhz3WF8cAr5e4foWl3kr4IBcnhL5VaRWeJPvrwIr7D0dgaE2lerCDaRiRQxwrQ6I4Db2sl4aJZC7VxMUfZCFV12iD7OylkxcRB1FhC3jvjXiWRt5EqcfwZDZD';
const PHONE_NUMBER_ID = '1114413501761892';

// Meta requires a webhook verification step when you first connect it
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === 'my_secret_token') {
        res.send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

// Listen for incoming WhatsApp messages
app.post('/webhook', async (req, res) => {
    // 1. Send the response to Meta immediately so it stops hanging
    res.sendStatus(200); 

    // 2. Add this line to print the entire incoming object to your terminal
    console.log("=== INCOMING WEBHOOK PAYLOAD ===");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("================================");

    const body = req.body;
    
    // Drill down into Meta's JSON payload to find the message text
    if (body.object && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        const msg = body.entry[0].changes[0].value.messages[0];
        const fromNumber = msg.from;
        const text = msg.text?.body?.toLowerCase() || '';

        if (text.startsWith('!pokedex ')) {
            const pokemonName = text.split(' ')[1];

            try {
                // Fetch from the free PokéAPI
                const pokeRes = await axios.get(`https://pokeapi.co/api/v2/pokemon/${pokemonName}`);
                const data = pokeRes.data;

                // DOWNLOAD PHOTO
                const imageUrl = data.sprites.other['official-artwork'].front_default || data.sprites.front_default;
                
                const replyText = `*${data.name.toUpperCase()}*\n` +
                                  `Type: ${data.types.map(t => t.type.name).join(', ')}\n` +
                                  `Weight: ${data.weight / 10}kg\n` +
                                  `Height: ${data.height / 10}m\n\n` +
                                  `Need an override? Is it the wrong Pokemon? (Showing: ${data.name})`;

                // Send the reply back via Meta's Cloud API
                await axios({
                    method: 'POST',
                    url: `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
                    headers: {
                        'Authorization': `Bearer ${TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    data: {
                        messaging_product: 'whatsapp',
                        to: fromNumber,
                        type: 'image',
                        image: {
                            link: imageUrl,
                            caption: replyText
                        }
                    }
                });

            } catch (error) {
                // Send an error text if the Pokémon isn't found
                await axios({
                    method: 'POST',
                    url: `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
                    headers: { 
                        'Authorization': `Bearer ${TOKEN}`, 
                        'Content-Type': 'application/json' 
                    },
                    data: {
                        messaging_product: 'whatsapp',
                        to: fromNumber,
                        type: 'text',
                        text: { body: "Could not find that Pokémon. Please check the spelling!" }
                    }
                });
            }
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pokédex Webhook running on port ${PORT}`));