import axios from "axios";

export const loadDataTypes = async (setterCallback: any): Promise<void> => {
  axios.get('/app/data-types/list')
    .then((result) => setterCallback(result.data));
}
