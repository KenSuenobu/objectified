import axios from "axios";

export const loadFields = async (setterCallback: any): Promise<void> => {
  axios.get('/app/fields/list')
    .then((result) => setterCallback(result.data));
}
