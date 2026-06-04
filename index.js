const express = require('express');
const axios = require('axios');
const app = express();
const levenshtein = require('fast-levenshtein');

const { GoogleGenerativeAI } = require("@google/generative-ai");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const geminiModel = genAI.getGenerativeModel({
    model: "gemini-2.5-flash"
});

app.use(express.json());

// You will copy these from the Meta Developer Dashboard
const TOKEN = process.env.TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

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

const VERSION_PRIORITY = [
    'scarlet-violet',
    'legends-arceus',
    'brilliant-diamond-shining-pearl',
    'sword-shield',
    'ultra-sun-ultra-moon',
    'sun-moon',
    'omega-ruby-alpha-sapphire',
    'x-y',
    'black-2-white-2',
    'black-white',
    'heartgold-soulsilver',
    'platinum',
    'diamond-pearl',
    'firered-leafgreen',
    'emerald',
    'ruby-sapphire',
    'crystal',
    'gold-silver',
    'yellow',
    'red-blue'
];

const REGIONAL_FORMS = {
    'a-': 'alola',
    'g-': 'galar',
    'h-': 'hisui',
    'p-': 'paldea'
};

let pokemonNameCache = null;

async function getClosestPokemonName(input) {
    if (!pokemonNameCache) {
        const res = await axios.get('https://pokeapi.co/api/v2/pokemon?limit=2000');
        pokemonNameCache = res.data.results.map(p => p.name);
    }

    let closest = null;
    let smallestDistance = Infinity;

    for (const name of pokemonNameCache) {
        const distance = levenshtein.get(input, name);

        if (distance < smallestDistance) {
            smallestDistance = distance;
            closest = name;
        }
    }

    // Don't suggest completely unrelated names
    return smallestDistance <= 4 ? closest : null;
}

function getBaseSpeciesName(name) {
    return name
        .replace('-alola', '')
        .replace('-galar', '')
        .replace('-hisui', '')
        .replace('-paldea', '');
}

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

async function askGemini(userMessage) {

    const prompt =
        "Answer this question with short answer, as short and simplified as possible, with no extra information as long as the question is answered. Maximum 50 words.\n\nQuestion:\n" +
        userMessage;

    const result = await geminiModel.generateContent({
        contents: [
            {
                role: "user",
                parts: [{ text: prompt }]
            }
        ],
        // tools: [{
        //     googleSearch: {}
        // }],
        generationConfig: {
            maxOutputTokens: 100,
            temperature: 0.3
        }
    });

    return result.response.text().trim();
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
                    const speciesRes = await axios.get(
                        `https://pokeapi.co/api/v2/pokemon-species/${getBaseSpeciesName(pokemonName)}`
                    );
                    const chainUrl = speciesRes.data.evolution_chain.url;
                    const chainRes = await axios.get(chainUrl);
                    
                    const paths = buildEvoPaths(
                        chainRes.data.chain,
                        getBaseSpeciesName(pokemonName)
                    );
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

                    if (genInput && GEN_MAP[genInput]) {

                        targetGroups = GEN_MAP[genInput];
                        genTitle = `Gen ${genInput}`;

                    } else {

                        let newestVersion = null;

                        for (const version of VERSION_PRIORITY) {

                            const found = movesData.some(move =>
                                move.version_group_details.some(
                                    vg => vg.version_group.name === version
                                )
                            );

                            if (found) {
                                newestVersion = version;
                                break;
                            }
                        }

                        if (newestVersion) {

                            targetGroups = [newestVersion];

                            for (const [gen, groups] of Object.entries(GEN_MAP)) {
                                if (groups.includes(newestVersion)) {
                                    genTitle = `Gen ${gen}`;
                                    break;
                                }
                            }
                        }
                    }

                    let learnset = [];

                    movesData.forEach(move => {

                        const validEntry = move.version_group_details.find(vg =>
                            targetGroups.includes(vg.version_group.name) &&
                            vg.move_learn_method.name === 'level-up'
                        );

                        if (!validEntry) return;

                        learnset.push({
                            level: validEntry.level_learned_at,
                            name: cleanName(move.move.name)
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

                    if (
                        pokemonName.endsWith('-alola') ||
                        pokemonName.endsWith('-galar') ||
                        pokemonName.endsWith('-hisui') ||
                        pokemonName.endsWith('-paldea')
                    ) {
                        const highLevelMoves = uniqueMoves.filter(m => m.level > 1);

                        // Only strip Lv.1 moves if there are actually higher-level moves
                        if (highLevelMoves.length >= 5) {
                            uniqueMoves.splice(
                                0,
                                uniqueMoves.length,
                                ...highLevelMoves
                            );
                        }
                    }

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
                // MODE: STATS
                // ----------------------------------------------------
                else if (mode === 'stats') {

                    const pkmRes = await axios.get(
                        `https://pokeapi.co/api/v2/pokemon/${pokemonName}`
                    );

                    const pkm = pkmRes.data;

                    const statMap = {
                        hp: 'HP',
                        attack: 'Attack',
                        defense: 'Defense',
                        'special-attack': 'Sp. Attack',
                        'special-defense': 'Sp. Defense',
                        speed: 'Speed'
                    };

                    const stats = pkm.stats
                        .map(s =>
                            `${statMap[s.stat.name]}: ${s.base_stat}`
                        )
                        .join('\n');

                    const abilities = pkm.abilities
                        .map(a => {
                            const name = cleanName(a.ability.name);

                            return a.is_hidden
                                ? `${name} (Hidden)`
                                : name;
                        })
                        .join('\n');

                    const bst = pkm.stats.reduce(
                        (sum, stat) => sum + stat.base_stat,
                        0
                    );

                    const message =
                        `*${cleanName(pokemonName)} Base Stats*\n\n` +
                        `${stats}\n\n` +
                        `*BST:* ${bst}\n\n` +
                        `*Abilities:*\n${abilities}`;

                    await sendText(fromNumber, message);
                }

                // ----------------------------------------------------
                // MODE: STANDARD POKEDEX PROFILE
                // ----------------------------------------------------
                else {
                    const pkmRes = await axios.get(`https://pokeapi.co/api/v2/pokemon/${pokemonName}`);
                    const speciesRes = await axios.get(
                        `https://pokeapi.co/api/v2/pokemon-species/${getBaseSpeciesName(pokemonName)}`
                    );
                    
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

                    const displayName = cleanName(
                        pkm.name
                            .replace('-alola', ' (Alolan)')
                            .replace('-galar', ' (Galarian)')
                            .replace('-hisui', ' (Hisuian)')
                            .replace('-paldea', ' (Paldean)')
                    );

                    const caption = `*No. ${idString}* | *${displayName.toUpperCase()}*\n` +
                                    `_${category}_\n\n` +
                                    `• *Type:* ${types}\n` +
                                    `• *Height:* ${pkm.height / 10} m\n` +
                                    `• *Weight:* ${pkm.weight / 10} kg\n\n` +
                                    `*Description:*\n${textDescription}\n\n`;

                    await sendImage(fromNumber, imageUrl, caption);
                }

            } catch (error) {

                const suggestion = await getClosestPokemonName(
                    getBaseSpeciesName(pokemonName)
                );

                let errortext =
                    `Could not process command for "${pokemonName}".\n\n`;

                if (suggestion) {
                    errortext +=
                        `Did you mean *${cleanName(suggestion)}*?\n\n`;
                }

                errortext +=
                    `*List of commands:*\n` +
                    `![pkm name] - Shows Pokedex Info\n` +
                    `![pkm name] moves - Shows Moves Learnset\n` +
                    `![pkm name] evo - Shows Evo Line\n` +
                    `![pkm name] stats - Shows Base Stats + Abilities`;

                await sendText(fromNumber, errortext);
            }
        } else {

            try {

                const answer = await askGemini(incomingText);

                await sendText(fromNumber, answer);

            } catch (err) {

                console.error("Gemini Error:", err);

                await sendText(
                    fromNumber,
                    "Sorry, I couldn't process that question right now."
                );
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
