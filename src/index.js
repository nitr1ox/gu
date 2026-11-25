require('dotenv').config();
const manager = require('./botmanager');
const schedule = require('./schedule');
const { startWeb } = require('./web');

startWeb();
manager.bootAll().then(() => { manager.startRefreshLoop(); return schedule.start(); });
