require('dotenv').config();
const manager = require('./botmanager');
const { startWeb } = require('./web');

startWeb();
manager.bootAll().then(() => manager.startRefreshLoop());
