// Created with assistance from the following video tutorial: https://www.youtube.com/watch?v=-fnLEO4e-3Y

import { create } from "zustand";
import {Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle} from '@mui/material';

type ConfirmDialogStore = {
  message: string;
  onSubmit?: () => void;
  isOpen: boolean;
  close: () => void;
}

const useConfirmDialogStore = create<ConfirmDialogStore>((set) => ({
  message: '',
  onSubmit: undefined,
  isOpen: false,

  // This close function will unset the onSubmit function, which tells the confirm dialog's "open" field that
  // the dialog is closed.  This is a fire-and-forget function: close will be called once, unsetting the
  // onSubmit function.  Each subsequent open to the dialog is based on whether the onSubmit function
  // has been populated at runtime.
  close: () =>
    set({
      onSubmit: undefined,
      isOpen: false,
    }),
}));

export const confirmDialog = (message: string, onSubmit: () => void) => {
  useConfirmDialogStore.setState({
    message, onSubmit, isOpen: true
  });
}

const ConfirmDialog: React.FC = () => {
  const { message, onSubmit, isOpen, close } = useConfirmDialogStore();

  return (
    <Dialog open={isOpen} onClose={close} maxWidth={'sm'} fullWidth>
      <DialogTitle fontWeight={'bold'}>Confirm</DialogTitle>
      <DialogContent>
        <DialogContentText>{message}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button color={'error'} variant={'contained'} onClick={close}>No</Button>
        <Button color={'primary'} variant={'contained'} onClick={() => {
          if (onSubmit) {
            onSubmit();
          }

          close();
        }}>Yes</Button>
      </DialogActions>
    </Dialog>
  );
};

export default ConfirmDialog;
