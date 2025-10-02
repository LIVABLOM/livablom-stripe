import fetch from 'node-fetch';
import icalParser from 'node-ical';

const LIVA_URL = 'http://localhost:5000/calendar/liva';
const BLOM_URL = 'http://localhost:5000/calendar/blom';

async function testCalendar(url, name) {
  try {
    const response = await fetch(url);
    const text = await response.text();
    const events = Object.values(icalParser.parseICS(text)).filter(e => e.type === 'VEVENT');
    if (events.length > 0) {
      console.log(`✅ ${name} : ${events.length} événements trouvés`);
    } else {
      console.warn(`⚠️ ${name} : aucun événement trouvé`);
    }
  } catch (err) {
    console.error(`❌ Erreur pour ${name} :`, err);
  }
}

async function runTests() {
  await testCalendar(LIVA_URL, 'LIVA Calendar');
  await testCalendar(BLOM_URL, 'BLŌM Calendar');
}

runTests();
