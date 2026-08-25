import assert from "node:assert/strict";
import test from "node:test";

import { formatWeather, lookupWeather } from "../bots/weather/weather.js";

test("formats current weather", () => {
  assert.equal(
    formatWeather({
      name: "London",
      country: "United Kingdom",
      temperature: 18.4,
      feelsLike: 17.9,
      humidity: 72,
      windSpeed: 11.2,
      weatherCode: 2,
    }),
    "London, United Kingdom\nPartly cloudy\n18.4°C (feels like 17.9°C)\nHumidity: 72% | Wind: 11.2 km/h",
  );
});

test("looks up a location and current weather", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("geocoding-api")) {
      return {
        ok: true,
        json: async () => ({ results: [{ name: "London", country: "United Kingdom", latitude: 51.5, longitude: -0.1 }] }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        timezone: "Europe/London",
        current: {
          temperature_2m: 18.4,
          apparent_temperature: 17.9,
          relative_humidity_2m: 72,
          wind_speed_10m: 11.2,
          weather_code: 2,
        },
      }),
    };
  };

  const weather = await lookupWeather("London", fetchImpl);
  assert.equal(weather.name, "London");
  assert.equal(weather.temperature, 18.4);
  assert.equal(weather.weatherCode, 2);
  assert.equal(calls.length, 2);
});