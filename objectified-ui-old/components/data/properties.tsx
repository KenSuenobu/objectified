import axios from "axios";

export const loadProperties = async (setterCallback: any): Promise<void> => {
  axios.get('/app/property/list')
    .then((result) => setterCallback(result.data));
}