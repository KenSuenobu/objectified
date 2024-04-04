import axios from "axios";

export const loadNamespaces = async (setterCallback: any): Promise<void> => {
  axios.get('/app/namespaces/list')
    .then((result) => setterCallback(result.data));
}
