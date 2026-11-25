var NodeHelper = require("node_helper");
var axios = require("axios");
var moment = require("moment");
const multisort = require("multisort");

const Log = require("logger");

// URL for the POST request
var URL = "https://www.westberks.gov.uk/apiserver/ajaxlibrary";

// Set the request headers
var HEADERS = {
  'Content-Type': 'application/json; charset=UTF-8',
  'User-Agent': 'PostmanRuntime/7.32.2',
  'Accept': '*/*',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive'
};

// Define the JSON payloads
var json_payload_methods = {
  nextRubbishDateText: "goss.echo.westberks.forms.getNextRubbishCollectionDate",
  nextRecyclingDateText: "goss.echo.westberks.forms.getNextRecyclingCollectionDate",
  nextFoodWasteDateText: "goss.echo.westberks.forms.getNextFoodWasteCollectionDate"
};

var __keyName = "";

function convertStringToDate(dateString) {
  // Define the month names and their respective indexes
  const monthNames = {
    January: 0,
    February: 1,
    March: 2,
    April: 3,
    May: 4,
    June: 5,
    July: 6,
    August: 7,
    September: 8,
    October: 9,
    November: 10,
    December: 11
  };

  // Split the input string by space
  const parts = dateString.split(' ');

  // Ensure the input string has three parts
  if (parts.length !== 3) {
    return dateString;
    throw new Error('Invalid date string format. Expected format: "Weekday Day Month".');
  }

  // Extract the day, month, and year values
  const day = parseInt(parts[1]);
  const month = monthNames[parts[2]];

  // Ensure day and month are valid numbers
  if (isNaN(day) || isNaN(month)) {
    throw new Error('Invalid day or month value.');
  }

  // Ensure day is within a valid range
  if (day < 1 || day > 31) {
    throw new Error('Invalid day value. Day must be between 1 and 31.');
  }

  // Ensure month is within a valid range
  if (month < 0 || month > 11) {
    throw new Error('Invalid month value. Month must be between 0 and 11.');
  }

  // Create a new Date object using the extracted values
  const year = new Date().getFullYear(); // Assumes current year
  const dateObject = new Date(year, month, day);

  return dateObject;
}


module.exports = NodeHelper.create({
  start: function () {
    console.log("Starting node_helper for module: " + this.name);
    this.pendingRequests = new Set();
  },

  getPickupMethodJSON: function (_method, _uprn) {
    //var __requestId = Math.random() * (9999999999 - 1000000000) + 1000000000;
    return {
      jsonrpc: "2.0",
      id: "1",
      //        id: __requestId,
      method: _method,
      params: {
        uprn: _uprn,
      }
    }
  },

  
  socketNotificationReceived: function (notification, payload) {
    var self = this;
    if (notification == "MMM-WESTBERKSBINDAY-CONFIG") {
      this.config = payload;
    } else if (notification == "MMM-WESTBERKSBINDAY-GET") {
      if (this.pendingRequests.has(payload.instanceId)) {
        return;
      }
      this.pendingRequests.add(payload.instanceId);

      var requests = Object.keys(json_payload_methods).map(function (key) {
        var pickupJson = self.getPickupMethodJSON(json_payload_methods[key], payload.uprn);
        return axios.post(URL, pickupJson, { headers: HEADERS, timeout: 15000 });
      });

      Promise.all(requests).then(function (responses) {
        var schedule = [];
        responses.forEach(function (response) {
          if (!response.data || !response.data.result || typeof response.data.result !== "object") {
            throw new Error("West Berkshire API returned an unexpected response.");
          }

          Object.keys(response.data.result).forEach(function (reskey) {
            if (reskey == payload.refuseServiceName ||
              reskey == payload.recyclingServiceName ||
              reskey == payload.foodWasteServiceName) {
              schedule.push({ ServiceName: reskey, nextDateText: response.data.result[reskey] });
            }
          });
        });

        if (schedule.length === 0) {
          throw new Error("West Berkshire API response did not contain the expected collection data.");
        }

        self.getNextPickups(payload, schedule);
      }).catch(function (error) {
        var status = error.response && error.response.status;
        var message = status
          ? `West Berkshire API request failed with HTTP ${status}.`
          : error.message || "Could not reach the West Berkshire API.";
        Log.error(`MMM-WestBerksBinDays: ${message}`);
        self.sendSocketNotification("MMM-WESTBERKSBINDAY-ERROR" + payload.instanceId, { message: message });
      }).then(function () {
        self.pendingRequests.delete(payload.instanceId);
      });
    }
  },




  getNextPickups: function (payload, schedule) {
    var nextPickups = [];

    Log.info("MMM-WestBerksBinDays: getNextPickups Schedule Length=" + schedule.length);
    for (let i = 0; i < schedule.length; i++) {
      var element = schedule[i];
      Log.info(`MMM-WestBerksBinDays: getNextPickups element.ServiceName = ${element.ServiceName}`);
      Log.info(`MMM-WestBerksBinDays: getNextPickups element.nextDateText = ${element.nextDateText}`);

      try {
        if (element.ServiceName == payload.refuseServiceName) {
          var refusePickup = {
            pickupDate: convertStringToDate(element.nextDateText),
            pickupType: "Refuse Bin",
          };
          nextPickups.push(refusePickup);
        }
        else if (element.ServiceName == payload.recyclingServiceName) {
          var greenPickup = {
            pickupDate: convertStringToDate(element.nextDateText),
            pickupType: "Recycling",
          };
          nextPickups.push(greenPickup);
        }
        else if (element.ServiceName == payload.foodWasteServiceName) {
          var foodwastePickup = {
            pickupDate: convertStringToDate(element.nextDateText),
            pickupType: "Food Bin",
          };
          nextPickups.push(foodwastePickup);
        }
      } catch (error) {
        Log.error('Error:', error.message);
      }

    }
    //Log.info("nextPickups length (pre sort): "+ nextPickups.length);
    multisort(nextPickups, ["pickupDate"]);
    //Log.info("nextPickups length: "+ nextPickups.length);

    this.sendSocketNotification("MMM-WESTBERKSBINDAY-RESPONSE" + payload.instanceId, nextPickups);
  },
});
