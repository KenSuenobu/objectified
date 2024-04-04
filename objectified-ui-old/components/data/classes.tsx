import axios from "axios";

export const loadClasses = async (setterCallback: any): Promise<void> => {
  axios.get('/app/classes/list')
    .then((result) => setterCallback(result.data));
}