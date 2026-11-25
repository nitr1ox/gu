require('dotenv').config();
const { createBot } = require('./bot');
const { startWeb } = require('./web');

const client = createBot();
startWeb(client);
client.login(process.env.BOT_TOKEN);
