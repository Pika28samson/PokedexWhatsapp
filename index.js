const axios = require("axios");

axios
  .get("https://generativelanguage.googleapis.com")
  .then(r => console.log(r.status))
  .catch(console.error);
