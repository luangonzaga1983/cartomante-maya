// Servidor local: npm start  ->  http://localhost:3000
const app = require('./app');
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Site rodando em http://localhost:' + PORT));
