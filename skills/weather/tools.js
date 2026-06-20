export const tools = [
    {
        name: "GetWeather",
        description: "Fetches current weather information for a given city.",
        executeFn: async (city) => {
            const mockWeather = {
                "london": "15°C, Light rain, Wind 12km/h, Humidity 82%",
                "new york": "22°C, Sunny, Wind 8km/h, Humidity 45%",
                "tokyo": "26°C, Humid and Partly Cloudy, Wind 5km/h, Humidity 70%",
                "paris": "19°C, Partly Cloudy, Wind 10km/h, Humidity 55%",
                "sydney": "18°C, Clear, Wind 15km/h, Humidity 60%",
                "berlin": "17°C, Overcast, Wind 9km/h, Humidity 75%"
            };
            
            const normalized = city.trim().toLowerCase();
            for (const key of Object.keys(mockWeather)) {
                if (normalized.includes(key)) {
                    return mockWeather[key];
                }
            }
            return `20°C, Clear Sky, Wind 7km/h (Default forecast for ${city})`;
        }
    }
];
