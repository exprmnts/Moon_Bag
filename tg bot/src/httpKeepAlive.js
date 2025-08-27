const http = require("http");

const PORT = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    res.end("Telegram bot is alive 👍");
  })
  .listen(PORT, () => {
    console.log(`HTTP keep-alive server listening on ${PORT}`);
  });
