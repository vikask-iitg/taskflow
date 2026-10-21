// Local development / self-hosting entry point
const app = require('./app');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TaskFlow running at http://localhost:${PORT}`));
