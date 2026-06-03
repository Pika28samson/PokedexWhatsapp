const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// You will copy these from the Meta Developer Dashboard
const TOKEN = 'EAAOZBMSeaZAGEBRjQ9iUvYktGu2eHm7Btt0q4WTVRDFn4WuR1co5i9GU1KrS0CkuOGGhdOxAfjhz3WF8cAr5e4foWl3kr4IBcnhL5VaRWeJPvrwIr7D0dgaE2lerCDaRiRQxwrQ6I4Db2sl4aJZC7VxMUfZCFV12iD7OylkxcRB1FhC3jvjXiWRt5EqcfwZDZD';
const PHONE_NUMBER_ID = '1114413501761892';

// Map generations to PokéAPI version groups
const GEN_MAP = {
    '1': ['red-blue', 'yellow'],
    '2': ['gold-silver', 'crystal'],
    '3': ['ruby-sapphire', 'emerald', 'firered-leafgreen'],
    '4': ['diamond-pearl', 'platinum', 'heartgold-soulsilver'],
    '5': ['black-white', 'black-2-white-2'],
    '6': ['x-y', 'omega-ruby-alpha-sapphire'],
    '7': ['sun-moon', 'ultra-sun-ultra-moon'],
    '8': ['sword-shield', 'brilliant-diamond-shining-pearl', 'legends-arceus'],
    '9': ['scarlet-violet']
};

const REGIONAL_FORMS = {
    'a-': 'alola',
    'g-': 'galar',
    'h-': 'hisui',
    'p-': 'paldea'
};

function normalizePokemonName(name) {
    for (const [prefix, region] of Object.entries(REGIONAL_FORMS)) {
        if (name.startsWith(prefix)) {
            return `${name.slice(prefix.length)}-${region}`;
        }
    }
    return name;
}

// Helper function to make strings look pristine
function cleanName(str) {
    return str.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// Helper to parse complex evolution methods cleanly
function getEvoDetails(details) {
    if (!details || details.length === 0) return '--> ';
    const d = details[0];
    let triggers = [];

    if (d.min_level) triggers.push(`Lvl ${d.min_level}`);
    if (d.item) triggers.push(cleanName(d.item.name));
    if (d.held_item) triggers.push(`holding ${cleanName(d.held_item.name)}`);
    if (d.location) triggers.push(`at ${cleanName(d.location.name)}`);
    if (d.known_move) triggers.push(`knowing ${cleanName(d.known_move.name)}`);
    if (d.min_happiness) triggers.push(`High Happiness`);
    if (d.time_of_day) triggers.push(`at ${d.time_of_day}`);
    
    // Fallback for weird hyper-specific evolution methods (e.g., Galarian evolutions)
    if (triggers.length === 0 && d.trigger && d.trigger.name !== 'level-up') {
        triggers.push(cleanName(d.trigger.name));
    }

    return triggers.length > 0 ? `-- ${triggers.join(' + ')} --> ` : '--> ';
}

// Recursive path building for branching evolution lines
function buildEvoPaths(node, targetName, currentPath = '') {
    let pkmName = cleanName(node.species.name);
    if (node.species.name === targetName) pkmName = `*${pkmName}*`;
    
    let path = currentPath ? `${currentPath} ${pkmName}` : pkmName;
    
    if (!node.evolves_to || node.evolves_to.length === 0) {
        return [path];
    }
    
    let paths = [];
    node.evolves_to.forEach(evo => {
        const arrow = getEvoDetails(evo.evolution_details);
        const nextPaths = buildEvoPaths(evo, targetName, `${path} ${arrow}`);
        paths.push(...nextPaths);
    });
    return paths;
}

// Core HTTP ping keep-alive endpoint for cron-job.org
app.get('/', (req, res) => {
    res.status(200).send('Pokédex Bot is awake and running!');
});

// Verification endpoint for Meta Cloud API installation
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === 'my_secret_token') {
        res.send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

// Incoming message handler pipeline
app.post('/webhook', async (req, res) => {
    res.sendStatus(200); 

    const body = req.body;
    if (body.object && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        const msg = body.entry[0].changes[0].value.messages[0];
        const fromNumber = msg.from;
        const incomingText = msg.text?.body?.trim() || '';

        // Match any incoming message starting with '!'
        if (incomingText.startsWith('!')) {
            const parts = incomingText.slice(1).split(/\s+/);
            const pokemonName = normalizePokemonName(parts[0].toLowerCase());
            const mode = parts[1]?.toLowerCase();
            const genInput = parts[2];

            try {
                // ----------------------------------------------------
                // MODE: EVOLUTIONS
                // ----------------------------------------------------
                if (mode === 'evo') {
                    const speciesRes = await axios.get(`https://pokeapi.co/api/v2/pokemon-species/${pokemonName}`);
                    const chainUrl = speciesRes.data.evolution_chain.url;
                    const chainRes = await axios.get(chainUrl);
                    
                    const paths = buildEvoPaths(chainRes.data.chain, pokemonName);
                    const formattedMessage = `*Evolution Line for ${cleanName(pokemonName)}:*\n\n` + paths.join('\n');
                    
                    await sendText(fromNumber, formattedMessage);
                }
                
                // ----------------------------------------------------
                // MODE: MOVESET LEARNSET
                // ----------------------------------------------------
                else if (mode === 'moves') {
                    const pkmRes = await axios.get(`https://pokeapi.co/api/v2/pokemon/${pokemonName}`);
                    const movesData = pkmRes.data.moves;
                    
                    let targetGroups = [];
                    let genTitle = "Latest Gen";

                    // Default to newest generation if none specified
                    if (!genInput) {
                        const latestGen = Object.keys(GEN_MAP)
                            .map(Number)
                            .sort((a, b) => b - a)[0];

                        targetGroups = GEN_MAP[latestGen.toString()];
                        genTitle = `Gen ${latestGen}`;
                    }
                    else if (GEN_MAP[genInput]) {
                        targetGroups = GEN_MAP[genInput];
                        genTitle = `Gen ${genInput}`;
                    }

                    let learnset = [];
                    movesData.forEach(m => {
                        m.version_group_details.forEach(vg => {
                            const matchGroup = targetGroups.length === 0 || targetGroups.includes(vg.version_group.name);
                            if (matchGroup && vg.move_learn_method.name === 'level-up') {
                                learnset.push({
                                    level: vg.level_learned_at,
                                    name: cleanName(m.move.name)
                                });
                            }
                        });
                    });

                    // Deduplicate and sort moves ascending by level
                    const uniqueMoves = [];
                    const map = new Map();
                    for (const item of learnset) {
                        const key = `${item.level}-${item.name}`;
                        if(!map.has(key)){
                            map.set(key, true);
                            uniqueMoves.push(item);
                        }
                    }
                    uniqueMoves.sort((a, b) => a.level - b.level);

                    if (uniqueMoves.length === 0) {
                        await sendText(fromNumber, `No level-up moves found for ${cleanName(pokemonName)} in ${genTitle}.`);
                        return;
                    }

                    let moveListText = `*${cleanName(pokemonName)} Level-Up Moves (${genTitle}):*\n`;
                    uniqueMoves.forEach(m => {
                        moveListText += `• Lv. ${m.level.toString().padEnd(2, ' ')} - ${m.name}\n`;
                    });

                    await sendText(fromNumber, moveListText);
                }
                
                // ----------------------------------------------------
                // MODE: STANDARD POKEDEX PROFILE
                // ----------------------------------------------------
                else {
                    const pkmRes = await axios.get(`https://pokeapi.co/api/v2/pokemon/${pokemonName}`);
                    const speciesRes = await axios.get(`https://pokeapi.co/api/v2/pokemon-species/${pokemonName}`);
                    
                    const pkm = pkmRes.data;
                    const species = speciesRes.data;

                    // Pull localized English data fields safely
                    const entry = species.flavor_text_entries.find(e => e.language.name === 'en');
                    const textDescription = entry ? entry.flavor_text.replace(/[\n\f]/g, ' ') : 'No description database entry.';
                    
                    const genusMatch = species.genera.find(g => g.language.name === 'en');
                    const category = genusMatch ? genusMatch.genus : 'Unknown Pokémon';

                    const imageUrl = pkm.sprites.other['official-artwork'].front_default || pkm.sprites.front_default;
                    const idString = pkm.id.toString().padStart(4, '0');
                    const types = pkm.types.map(t => cleanName(t.type.name)).join(' / ');

                    const caption = `*No. ${idString}* | *${pkm.name.toUpperCase()}*\n` +
                                    `_${category}_\n\n` +
                                    `• *Type:* ${types}\n` +
                                    `• *Height:* ${pkm.height / 10} m\n` +
                                    `• *Weight:* ${pkm.weight / 10} kg\n\n` +
                                    `*Description:*\n${textDescription}\n\n`;

                    await sendImage(fromNumber, imageUrl, caption);
                }

            } catch (error) {
                await sendText(fromNumber, `Could not process command for "${pokemonName}". Check syntax spelling!`);
            }
        }
    }
});

// Wrapper helper to dispatch images via Meta Cloud API
async function sendImage(to, url, caption) {
    await axios({
        method: 'POST',
        url: `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
        headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        data: {
            messaging_product: 'whatsapp',
            to: to,
            type: 'image',
            image: { link: url, caption: caption }
        }
    });
}

// Wrapper helper to dispatch text lines via Meta Cloud API
async function sendText(to, text) {
    await axios({
        method: 'POST',
        url: `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
        headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        data: {
            messaging_product: 'whatsapp',
            to: to,
            type: 'text',
            text: { body: text }
        }
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pokédex Webhook running on port ${PORT}`));
