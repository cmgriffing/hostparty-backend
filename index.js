const tmi = require("tmi.js");
const cloneDeep = require("lodash/cloneDeep");
const axios = require("axios");

const Primus = require("primus");
const http = require("http");
const express = require("express");

const defaultState = {
  streams: [],
  currentStream: "",
  currentStreamVoteCount: 0,
  stayCommandTimestamps: {},
  nextCommandTimestamps: {},
  currentCommandTimestamp: Date.now(),
  changeStreamTimeout: 30000,
  isPartying: false,
};

let devConfig;

try {
  devConfig = require("./config.json");
} catch (e) {
  console.log("No dev config file found for hostparty-backend.");
}

let config = devConfig;

try {
  config = require(process.cwd() + "/config.json");
} catch (e) {
  console.log("No local config found.");
  if (!config) {
    console.error("No config file found for hostparty-backend.");
    // process.exit(1);
  }
}

let messageHandler;
let spark;
let searchInterval;
let state = cloneDeep(defaultState);

function startServers(serverConfig) {
  const app = express();
  app.use(express.static(__dirname + "/static"));

  const server = http.createServer(app);
  primus = new Primus(server, {});

  server.listen(4242);
}

function fetchStreams() {
  // state.streams = [
  //   "cmgriffing",
  //   "griffingandchill",
  //   "theprimeagen",
  //   "strager",
  //   "newnoiseworks",
  // ];

  // This should be fine to have here hardcoded. It is a public value.
  let clientId = "6mpwge1p7z0yxjsibbbupjuepqhqe2"; //config.clientId;
  if (config.clientId && config.clientId !== "") {
    clientId = config.clientId;
  }

  return axios
    .get(
      `https://api.twitch.tv/kraken/search/streams?query=${encodeURIComponent(
        config.titleKeyword
      )}`,
      {
        headers: {
          Accept: "application/vnd.twitchtv.v5+json",
          "Client-ID": clientId,
          Authorization: config.oauthToken,
        },
      }
    )
    .then((result) => {
      console.log("streams", result.data.streams);
      state.streams = result.data.streams
        .filter((stream) => {
          return stream.channel.status.indexOf(config.titleKeyword) > 0;
        })
        .map((stream) => {
          return stream.channel.name;
        });
    })
    .catch((e) => {
      console.log({ e });
    });
}

function startHostParty(hostPartyConfig) {
  if (hostPartyConfig) {
    config = hostPartyConfig;
  }

  state = cloneDeep(defaultState);

  if (searchInterval) {
    clearInterval(searchInterval);
  }
  searchInterval = setInterval(() => {
    fetchStreams();
  }, 30000);
  fetchStreams();

  // coerce config values against defaults
  tmiClient = new tmi.client({
    channels: [...config.channels],
  });
  tmiClient.connect();

  tmiClient.on("message", (...args) => {
    if (messageHandler) {
      messageHandler(...args);
    }
  });

  primus.on("connection", function (_spark) {
    spark = _spark;
    if (!messageHandler) {
      messageHandler = (channel, userstate, message, self) => {
        console.log("Message: ", message);
        // check if is next or stay
        if (config.messageTypes.indexOf(userstate["message-type"]) === -1) {
          // This message type is not one of the configured events to listen to
          console.log("Message type is not right: ", userstate["message-type"]);
          return;
        }

        const hasNextCommand = message.indexOf(config.nextCommand) > -1;
        const hasStayCommand = message.indexOf(config.stayCommand) > -1;
        const hasCurrentCommand = message.indexOf(config.currentCommand) > -1;

        if (
          hasCurrentCommand &&
          Date.now() > state.currentCommandTimestamp + config.currentTimeoutMs
        ) {
          state.currentCommandTimestamp = Date.now();
          // say the stream name
          config.channels.map((channel) => {
            tmiClient.say(
              channel,
              `We are currently watching ${state.currentStream}. You can check it out here: https://twitch.tv/${state.currentStream}`
            );
          });
        }

        // --- might not be needed
        if (!hasNextCommand && !hasStayCommand) {
          // No command found
          console.log("No command found");
          return;
        }
        // ---

        const userId = userstate["user-id"];

        if (hasNextCommand) {
          console.log("Incrementing voteCount");
          const endOfTimeout =
            state.nextCommandTimestamps[userId] + config.voteTimeoutMs;
          if (
            !(state.nextCommandTimestamps[userId] && Date.now() < endOfTimeout)
          ) {
            state.nextCommandTimestamps[userId] = Date.now();
            state.currentStreamVoteCount += 1;
          }
        }

        if (hasStayCommand) {
          console.log("Decrementing voteCount");
          const endOfTimeout =
            state.stayCommandTimestamps[userId] + config.voteTimeoutMs;
          if (
            !(state.stayCommandTimestamps[userId] && Date.now() < endOfTimeout)
          ) {
            state.stayCommandTimestamps[userId] = Date.now();
            state.currentStreamVoteCount -= 1;
          }
        }

        const shouldUpdateTimestamp =
          (hasNextCommand && state.currentStreamVoteCount < 1) ||
          (hasStayCommand && state.currentStreamVoteCount > 0);

        spark.write({
          eventName: "voteCount",
          payload: state.currentStreamVoteCount,
          shouldUpdateTimestamp,
        });

        if (shouldUpdateTimestamp) {
          if (state.changeStreamTimeout) {
            clearTimeout(state.changeStreamTimeout);
          }

          state.changeStreamTimeout = setTimeout(() => {
            if (state.currentStreamVoteCount > 0) {
              changeStream();
            } else {
              console.log("Votes decided to STAY!");
            }
          }, config.voteTimeoutMs);
        }
      };
    }

    spark.on("data", (data) => {
      const { eventType, payload } = data;
      if (eventType === "configChange") {
        stopHostParty();
        config = { ...deepClone(config), ...payload };
        startHostParty();
      } else if (eventType === "nextStream") {
        changeStream();
      } else if (eventType === "startHostParty") {
        startHostParty();
      } else if (eventType === "stopHostParty") {
        stopHostParty();
      } else if (eventType === "resetVotes") {
        state.currentStreamVoteCount = 0;
        spark.write({
          eventName: "voteCount",
          payload: state.currentStreamVoteCount,
          shouldUpdateTimestamp: true,
        });
      }
    });

    spark.write({ eventName: "changeStream", payload: state.currentStream });
    spark.write({
      eventName: "voteCount",
      payload: state.currentStreamVoteCount,
    });
  });
}

function stopHostParty() {}

function changeStream() {
  const newStream =
    state.streams[Math.floor(Math.random() * state.streams.length)];

  state = {
    ...cloneDeep(defaultState),
    currentStream: newStream,
  };

  spark.write({ eventName: "changeStream", payload: newStream });
}

module.exports = {
  startServers,
  startHostParty,
  stopHostParty,
};
