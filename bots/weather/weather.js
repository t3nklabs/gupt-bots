const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const HEADERS = Object.freeze({
  accept: "application/json",
  "user-agent": "gupt-bots/weather",
});

async function getJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Weather API returned ${response.status}`);
  return response.json();
}

export async function lookupWeather(query, fetchImpl = fetch) {
  const q = String(query || "").trim();
  if (!q) return null;

  const search = await getJson(
    `${GEOCODING_URL}?name=${encodeURIComponent(q)}&count=1&language=en&format=json`,
    fetchImpl,
  );
  const location = search?.results?.[0];
  if (typeof location?.latitude !== "number" || typeof location?.longitude !== "number") return null;

  const forecast = await getJson(
    `${FORECAST_URL}?latitude=${location.latitude}&longitude=${location.longitude}` +
      "&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m" +
      "&temperature_unit=celsius&wind_speed_unit=kmh&timezone=auto",
    fetchImpl,
  );
  const current = forecast?.current;
  if (typeof current?.temperature_2m !== "number") return null;

  return {
    name: location.name,
    country: location.country,
    timezone: forecast.timezone,
    temperature: current.temperature_2m,
    feelsLike: current.apparent_temperature,
    humidity: current.relative_humidity_2m,
    windSpeed: current.wind_speed_10m,
    weatherCode: current.weather_code,
  };
}

const WEATHER_CODES = new Map([
  [0, "Clear sky"],
  [1, "Mainly clear"],
  [2, "Partly cloudy"],
  [3, "Overcast"],
  [45, "Fog"],
  [48, "Depositing rime fog"],
  [51, "Light drizzle"],
  [53, "Moderate drizzle"],
  [55, "Dense drizzle"],
  [61, "Slight rain"],
  [63, "Moderate rain"],
  [65, "Heavy rain"],
  [71, "Slight snow"],
  [73, "Moderate snow"],
  [75, "Heavy snow"],
  [80, "Slight rain showers"],
  [81, "Moderate rain showers"],
  [82, "Violent rain showers"],
  [95, "Thunderstorm"],
  [96, "Thunderstorm with hail"],
  [99, "Thunderstorm with heavy hail"],
]);

export function formatWeather(weather) {
  const condition = WEATHER_CODES.get(weather.weatherCode) || "Unknown conditions";
  const location = [weather.name, weather.country].filter(Boolean).join(", ");
  return `${location}\n${condition}\n${weather.temperature.toFixed(1)}°C (feels like ${weather.feelsLike.toFixed(1)}°C)\nHumidity: ${weather.humidity}% | Wind: ${weather.windSpeed.toFixed(1)} km/h`;
}