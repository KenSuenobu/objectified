import {NextPage} from 'next';
import {Box, Stack} from '@mui/system';
import ListHeader from '../../components/ListHeader';
import React, {useEffect, useRef, useState} from 'react';
import LoadingMessage from '../../components/LoadingMessage';
import {
    Accordion, AccordionDetails,
    AccordionSummary,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle, FormControl, InputLabel, Select, SelectChangeEvent, Table, TableBody,
    TableCell, TableContainer,
    TableHead,
    TableRow,
    TextField, Typography
} from '@mui/material';
import { StackItem } from '../../components/StackItem';
import {NamespaceDto} from 'objectified-data/dist/src/dto/namespace.dto';
import axios from 'axios';
import {alertDialog, confirmDialog, errorDialog} from '../../components/dialogs/ConfirmDialog';
import Paper from '@mui/material/Paper';
import {
    CheckBox,
    CheckBoxOutlineBlank,
    Delete,
    DeleteOutline,
    Edit,
    EditOutlined,
    ExpandMoreOutlined
} from '@mui/icons-material';
import MenuItem from "@mui/material/MenuItem";
import {loadClasses} from "../../components/data/classes";
import {loadProperties} from "../../components/data/properties";
import SectionHeader from "../../components/SectionHeader";

const ClassProperties: NextPage = () => {
    const [properties, setProperties] = useState([]);
    const [classes, setClasses] = useState([]);
    const [classProperties, setClassProperties] = useState({});
    const [loading, setLoading] = useState(false);
    const [addFormShowing, setAddFormShowing] = useState(false);
    const [classId, setClassId] = useState(0);
    const [propertyId, setPropertyId] = useState(0);

    const reloadProperties = () => {
        setLoading(true);
        loadProperties(setProperties)
          .then(() => setLoading(false));
    }

    const reloadClasses = () => {
        setLoading(true);
        loadClasses(setClasses)
          .then(() => setLoading(false));
    }

    const reloadClassProperties = () => {
        setLoading(true);
        setLoading(false);
    }

    const addClassPropertyClicked = () => {
        if (classId === 0) {
            return errorDialog('Please select a class.');
        }

        if (propertyId === 0) {
            return errorDialog('Please select a property to assign to the selected class.');
        }

        axios.put(`/app/class-properties/add/${classId}/${propertyId}`)
          .then((x) => {
              setAddFormShowing(false);
              reloadClassProperties();
          })
          .catch((x) => {
              errorDialog(x.message);
          });
    }

    const handleAccordionChange = (panel: string) => (event: React.SyntheticEvent, expanded: boolean) => {
        console.log(`Panel: ${panel} expanded=${expanded}`);

        if (expanded) {
            axios.get(`/app/class-properties/get/${panel}`)
              .then((result) => {
                  const propertyList = result.data.propertyList;
                  const currentList = classProperties;

                  currentList[panel] = propertyList;
                  setClassProperties(currentList);

                  console.log(`Current list: ${JSON.stringify(currentList, null, 2)}`);
              });
        }
    }

    const classesList = () => {
        if (classes.length === 0) {
            return (
              <>
                  <Stack direction={'row'}>
                      <StackItem sx={{width: '100%', padding: '1em', color: '#000'}}>
                          <Typography fontWeight={'bold'}>No classes have been defined yet.</Typography>
                      </StackItem>
                  </Stack>
              </>
            );
        }

        return classes.map((row) => (
          <Accordion onChange={handleAccordionChange(row.id)}>
              <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
                  <Typography>
                      {row.name}
                  </Typography>
              </AccordionSummary>
              <AccordionDetails>
                  {classProperties[row.id] ? (<>
                        {JSON.stringify(classProperties[row.id], null, 2)}
                    </>
                  ) : (<>
                      <LoadingMessage label={'Retrieving class properties'}/>
                  </>)}
              </AccordionDetails>
          </Accordion>
        ));
    }

    const handleClassIdChanged = (event: SelectChangeEvent) => setClassId(event.target.value as number);
    const handlePropertyIdChanged = (event: SelectChangeEvent) => setPropertyId(event.target.value as number);

    useEffect(() => {
        reloadProperties();
        reloadClasses();
    }, []);

    if (loading) {
        return (
          <LoadingMessage label={'Retrieving class and property list, one moment ...'}/>
        );
    }

    return (
      <>
          <div sx={{width: '100%'}} style={{border: '1px solid #ddd', backgroundColor: '#fff'}}>
              <Dialog open={addFormShowing} maxWidth={'sm'} fullWidth>
                  <DialogTitle>Class Property</DialogTitle>
                  <DialogContent>
                      <Stack direction={'column'} sx={{padding: '1em'}}>
                          <StackItem sx={{width: '100%', padding: '4px'}}>
                              <FormControl fullWidth required>
                                  <InputLabel id={'class-label'} required>Class Name</InputLabel>
                                  <Select labelId={'class-label'} id={'class_id'} label={'Class Name'}
                                          onChange={handleClassIdChanged}
                                          value={classId}>
                                      {classes.map((x) => (
                                        <MenuItem value={x.id}>{x.name} ({x.description})</MenuItem>
                                      ))}
                                  </Select>
                              </FormControl>
                          </StackItem>

                          <StackItem sx={{width: '100%', padding: '4px'}}>
                              <FormControl fullWidth required>
                                  <InputLabel id={'property-label'} required>Property</InputLabel>
                                  <Select labelId={'property-label'} id={'property_id'} label={'Property'}
                                          onChange={handlePropertyIdChanged}
                                          value={propertyId}>
                                      {properties.map((x) => (
                                        <MenuItem value={x.id}>{x.name} ({x.description})</MenuItem>
                                      ))}
                                  </Select>
                              </FormControl>
                          </StackItem>
                      </Stack>
                  </DialogContent>
                  <DialogActions>
                      <Button onClick={() => addClassPropertyClicked()} variant={'contained'}>Add</Button>
                      <Button onClick={() => setAddFormShowing(false)} variant={'contained'}
                              color={'error'}>Cancel</Button>
                  </DialogActions>
              </Dialog>

              <SectionHeader header={'Class Properties'}>
                  <Typography>
                      Class Properties are used to define the names and field types of data that can be stored
                      in an instance of a Class.
                  </Typography>
              </SectionHeader>

              {classesList()}
          </div>
      </>
    );
}

export default ClassProperties;
